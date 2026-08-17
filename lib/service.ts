/**
 * The application's behaviour, independent of HTTP and of the database.
 *
 * Route handlers stay thin: authenticate, call one of these, serialise.
 *
 * Note the separation this version is built around: **who you are in this app**
 * (a Neon Auth user) is decoupled from **your gym account** (Elixia
 * credentials you link afterwards). That is why `linkElixia` exists as its own
 * operation rather than being folded into sign-in — the app has to stay usable
 * even if Elixia's login turns out to be unreachable from a server, which is
 * still an open question in docs/api.md §1.
 */

import { API_DISCOVERED, ElixiaClient, type BookingBackend } from './elixia';
import { MockElixiaClient } from './mock';
import { importEncryptionKey, decryptJson, encryptJson, DecryptionError } from './auth/crypto';
import { DuplicateSubscriptionError, type Repo } from './db/repo';
import { releasesFor, releasesInRange } from './planner';
import { executeBooking, describeReport } from './booking';
import { Logger } from './logger';
import { notifyChat } from './notify';
import { DEFAULT_TIMINGS } from './config';
import { needsRefresh } from './tokens';
import { WEEKDAYS } from './types';
import type { AppConfig } from './appConfig';
import type {
  BookingConfig,
  BookingHistoryEntry,
  DueEntry,
  Profile,
  SealedElixiaSecret,
  Subscription,
  Weekday,
} from './types';

/** How far ahead the reindex projects. Weekly classes recur well inside this. */
export const REINDEX_HORIZON_DAYS = 10;

export function backendFor(config: AppConfig): BookingBackend {
  return config.mock ? new MockElixiaClient() : new ElixiaClient();
}

export function timingConfig(profile: Profile): BookingConfig {
  return {
    timeZone: profile.timeZone,
    bookingWindowDays: profile.bookingWindowDays,
    classes: [],
    ...DEFAULT_TIMINGS,
  };
}

/** A problem to report back to the browser, with the status it deserves. */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

// --- profiles --------------------------------------------------------------

/**
 * Load a profile, creating it if the database trigger has not yet.
 *
 * The trigger normally handles this, but a user created before the schema was
 * applied would otherwise be authenticated and profile-less — able to sign in
 * and then fail on every subsequent query.
 */
export async function getOrCreateProfile(
  config: AppConfig,
  userId: string,
): Promise<Profile> {
  const existing = await config.repo.getProfile(userId);
  if (existing) return existing;

  const profile: Profile = {
    id: userId,
    bookingWindowDays: config.defaultBookingWindowDays,
    timeZone: config.defaultTimeZone,
    elixiaStatus: 'unlinked',
  };
  await config.repo.upsertProfile(profile);
  return profile;
}

// --- linking the Elixia account --------------------------------------------

async function sealSecret(
  config: AppConfig,
  secret: SealedElixiaSecret,
): Promise<string> {
  return encryptJson(await importEncryptionKey(config.encryptionKey), secret);
}

export async function openSecret(
  config: AppConfig,
  profile: Profile,
): Promise<SealedElixiaSecret> {
  if (!profile.elixiaSecret) throw new ServiceError('No Elixia account linked', 409);
  return decryptJson<SealedElixiaSecret>(
    await importEncryptionKey(config.encryptionKey),
    profile.elixiaSecret,
  );
}

/**
 * Verify Elixia credentials and store them sealed.
 *
 * The password is kept — encrypted — because the bot runs unattended for weeks
 * and re-authenticating is the only way to survive a session finally expiring
 * without emailing the user to come back and re-link. The UI says so plainly,
 * and `unlinkElixia` erases it.
 */
export async function linkElixia(
  config: AppConfig,
  profile: Profile,
  email: string,
  password: string,
  nowMs: number,
): Promise<Profile> {
  if (!email.trim() || !password) {
    throw new ServiceError('Elixia email and password are required', 400);
  }

  let tokens;
  try {
    tokens = await backendFor(config).login(email.trim(), password, nowMs);
  } catch (err) {
    const detail = config.mock ? ` (${(err as Error).message})` : '';
    throw new ServiceError(`Elixia rejected those credentials${detail}`, 401);
  }

  const updated: Profile = {
    ...profile,
    elixiaEmail: email.trim(),
    elixiaSecret: await sealSecret(config, { password, tokens }),
    elixiaStatus: 'ok',
    elixiaCheckedAtMs: nowMs,
  };

  await config.repo.upsertProfile(updated);
  await reindexProfile(config, updated, nowMs);
  return updated;
}

/** Forget the stored credentials entirely and stop booking. */
export async function unlinkElixia(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
): Promise<void> {
  const updated: Profile = {
    ...profile,
    elixiaEmail: undefined,
    elixiaSecret: undefined,
    elixiaStatus: 'unlinked',
    elixiaCheckedAtMs: nowMs,
  };
  await config.repo.upsertProfile(updated);
  // Scheduled releases would otherwise keep firing against a dead link.
  await config.repo.replaceDueEntries(profile.id, []);
}

// --- dashboard -------------------------------------------------------------

export interface DashboardView {
  account: {
    bookingWindowDays: number;
    timeZone: string;
    telegramChatId: string;
    elixiaEmail: string;
    elixiaStatus: Profile['elixiaStatus'];
  };
  subscriptions: Array<Subscription & { nextReleaseAt: string | null }>;
  history: BookingHistoryEntry[];
  dryRun: boolean;
  apiDiscovered: boolean;
  mock: boolean;
  ephemeralStore: boolean;
}

export async function buildDashboard(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
): Promise<DashboardView> {
  const subscriptions = await config.repo.listSubscriptions(profile.id);
  const timings = timingConfig(profile);

  return {
    account: {
      bookingWindowDays: profile.bookingWindowDays,
      timeZone: profile.timeZone,
      telegramChatId: profile.telegramChatId ?? '',
      elixiaEmail: profile.elixiaEmail ?? '',
      elixiaStatus: profile.elixiaStatus,
    },
    subscriptions: subscriptions.map((s) => {
      const next = releasesFor(
        { ...s, bookingWindowDays: s.bookingWindowDays ?? profile.bookingWindowDays },
        nowMs,
        timings,
      ).find((r) => r.releaseEpochMs > nowMs);
      return { ...s, nextReleaseAt: next ? new Date(next.releaseEpochMs).toISOString() : null };
    }),
    history: await config.repo.listHistory(profile.id),
    dryRun: config.dryRun,
    apiDiscovered: API_DISCOVERED || config.mock,
    mock: config.mock,
    ephemeralStore: config.ephemeralStore,
  };
}

// --- subscriptions ---------------------------------------------------------

export interface SubscriptionInput {
  className?: string;
  center?: string;
  weekday?: string;
  startTime?: string;
  onFull?: string;
}

export async function addSubscription(
  config: AppConfig,
  profile: Profile,
  input: SubscriptionInput,
  nowMs: number,
): Promise<Subscription> {
  const className = (input.className ?? '').trim();
  const center = (input.center ?? '').trim();
  const weekday = input.weekday as Weekday;
  const startTime = (input.startTime ?? '').trim();
  const onFull = input.onFull === 'skip' ? 'skip' : 'waitlist';

  if (!className) throw new ServiceError('Class name is required', 400);
  if (!center) throw new ServiceError('Centre is required', 400);
  if (!WEEKDAYS.includes(weekday)) throw new ServiceError('Pick a valid weekday', 400);
  if (!/^\d{1,2}:\d{2}$/.test(startTime)) {
    throw new ServiceError('Start time must look like 09:00', 400);
  }

  const existing = await config.repo.listSubscriptions(profile.id);

  let subscription: Subscription;
  try {
    subscription = await config.repo.createSubscription({
      userId: profile.id,
      className,
      center,
      weekday,
      startTime,
      onFull,
      priority: existing.length + 1,
    });
  } catch (err) {
    // The database's unique index is the real guard — it also stops two
    // concurrent requests from both getting through.
    if (err instanceof DuplicateSubscriptionError) {
      throw new ServiceError(err.message, 409);
    }
    throw err;
  }

  await reindexProfile(config, profile, nowMs);
  return subscription;
}

export async function mutateSubscription(
  config: AppConfig,
  profile: Profile,
  id: string,
  action: 'delete' | 'toggle',
  nowMs: number,
): Promise<void> {
  const existing = (await config.repo.listSubscriptions(profile.id)).find((s) => s.id === id);
  // Scoped to this user's own list, so one user cannot reach another's class.
  if (!existing) throw new ServiceError('No such class', 404);

  const ok =
    action === 'delete'
      ? await config.repo.deleteSubscription(profile.id, id)
      : await config.repo.setSubscriptionEnabled(profile.id, id, !existing.enabled);

  if (!ok) throw new ServiceError('No such class', 404);
  await reindexProfile(config, profile, nowMs);
}

export async function updateSettings(
  config: AppConfig,
  profile: Profile,
  input: { bookingWindowDays?: unknown; timeZone?: unknown; telegramChatId?: unknown },
  nowMs: number,
): Promise<Profile> {
  const bookingWindowDays = Number(input.bookingWindowDays);
  if (!Number.isInteger(bookingWindowDays) || bookingWindowDays < 0 || bookingWindowDays > 60) {
    throw new ServiceError('Booking window must be a whole number of days', 400);
  }

  const timeZone = String(input.timeZone ?? '').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ServiceError(`Not a valid timezone: ${timeZone}`, 400);
  }

  const telegramChatId = String(input.telegramChatId ?? '').trim();
  const updated: Profile = {
    ...profile,
    bookingWindowDays,
    timeZone,
    ...(telegramChatId ? { telegramChatId } : { telegramChatId: undefined }),
  };

  await config.repo.upsertProfile(updated);
  // Both the window and the zone move release instants, so the schedule must be
  // rebuilt or the cron would fire at the old times.
  await reindexProfile(config, updated, nowMs);
  return updated;
}

export async function planFor(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
  horizonDays = 14,
): Promise<Array<{ className: string; classDate: string; releaseAt: string }>> {
  const subscriptions = await config.repo.listSubscriptions(profile.id);
  const timings = timingConfig(profile);

  return subscriptions.flatMap((s) =>
    releasesInRange(
      { ...s, bookingWindowDays: s.bookingWindowDays ?? profile.bookingWindowDays },
      nowMs,
      nowMs + horizonDays * 24 * 60 * 60 * 1000,
      timings,
    ).map((r) => ({
      className: s.className,
      classDate: r.classDate,
      releaseAt: new Date(r.releaseEpochMs).toISOString(),
    })),
  );
}

// --- scheduling ------------------------------------------------------------

/** Recompute one profile's upcoming releases. */
export async function reindexProfile(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
  horizonDays = REINDEX_HORIZON_DAYS,
): Promise<number> {
  if (profile.elixiaStatus !== 'ok') {
    await config.repo.replaceDueEntries(profile.id, []);
    return 0;
  }

  const subscriptions = (await config.repo.listSubscriptions(profile.id)).filter((s) => s.enabled);
  const toMs = nowMs + horizonDays * 24 * 60 * 60 * 1000;
  const entries: DueEntry[] = [];

  for (const subscription of subscriptions) {
    const windowDays = subscription.bookingWindowDays ?? profile.bookingWindowDays;
    for (const release of releasesInRange(
      { ...subscription, bookingWindowDays: windowDays },
      nowMs,
      toMs,
      { timeZone: profile.timeZone, bookingWindowDays: profile.bookingWindowDays },
    )) {
      entries.push({
        userId: profile.id,
        subscriptionId: subscription.id,
        releaseEpochMs: release.releaseEpochMs,
        classEpochMs: release.classEpochMs,
        classDate: release.classDate,
        ...(release.releaseNote ? { releaseNote: release.releaseNote } : {}),
      });
    }
  }

  await config.repo.replaceDueEntries(profile.id, entries);
  return entries.length;
}

// --- the booking tick ------------------------------------------------------

export interface TickClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * When the host will kill this invocation. Passed down so the retry loop
   * finishes on its own terms and still records what happened, rather than
   * being cut off mid-attempt with nothing written.
   */
  deadlineMs?: number;
}

const MINUTE_MS = 60_000;

/**
 * Book everything due right now, across all users.
 *
 * The window spans the previous, current and next minute: the next minute gives
 * the handler lead time to prepare a session before sleeping to the exact
 * instant, and the previous one means a tick that fires late still finds the
 * slot rather than skipping it.
 */
export async function runDueBookings(
  config: AppConfig,
  nowMs: number = Date.now(),
  clock: TickClock = {},
): Promise<number> {
  const logger = new Logger(clock.now);
  const entries = await config.repo.claimDue(nowMs - MINUTE_MS, nowMs + MINUTE_MS);
  logger.log('cron.tick', { dueCount: entries.length });
  if (entries.length === 0) return 0;

  const byUser = new Map<string, DueEntry[]>();
  for (const entry of entries) {
    byUser.set(entry.userId, [...(byUser.get(entry.userId) ?? []), entry]);
  }

  const backend = backendFor(config);
  let handled = 0;

  for (const [userId, userEntries] of byUser) {
    const profile = await config.repo.getProfile(userId);
    if (!profile || profile.elixiaStatus !== 'ok') continue;

    const subscriptions = await config.repo.listSubscriptions(userId);
    const timings = timingConfig(profile);

    // Prepare the session before sleeping to T-0, never during the race.
    let tokens;
    try {
      const secret = await openSecret(config, profile);
      tokens = secret.tokens;

      if (!tokens || needsRefresh(tokens, nowMs)) {
        tokens = tokens?.refreshToken
          ? await backend.refresh(tokens, nowMs).catch(() =>
              backend.login(profile.elixiaEmail ?? '', secret.password, nowMs),
            )
          : // No usable refresh token: fall back to the stored password. This is
            // exactly why it is kept — otherwise the bot dies the first time a
            // session lapses and waits for the user to notice.
            await backend.login(profile.elixiaEmail ?? '', secret.password, nowMs);

        await config.repo.upsertProfile({
          ...profile,
          elixiaSecret: await sealSecret(config, { password: secret.password, tokens }),
          elixiaStatus: 'ok',
          elixiaCheckedAtMs: nowMs,
        });
      }
    } catch (err) {
      // Loud, not silent: mark it dead so the UI prompts for re-linking.
      await config.repo.upsertProfile({
        ...profile,
        elixiaStatus: 'expired',
        elixiaCheckedAtMs: nowMs,
      });
      logger.log('session.dead', {
        userId,
        error: err instanceof DecryptionError ? 'decryption failed' : (err as Error).message,
      });
      await notifyChat(
        config.telegramBotToken,
        profile.telegramChatId,
        '🚨 Elixia rejected your saved credentials and booking is paused. Re-link your account to resume.',
      );
      continue;
    }

    for (const entry of userEntries) {
      const subscription = subscriptions.find((s) => s.id === entry.subscriptionId);
      // The schedule is derived data; live subscriptions are the authority.
      if (!subscription || !subscription.enabled) continue;

      const report = await executeBooking(
        {
          desired: {
            ...subscription,
            bookingWindowDays: subscription.bookingWindowDays ?? profile.bookingWindowDays,
          },
          releaseEpochMs: entry.releaseEpochMs,
          classEpochMs: entry.classEpochMs,
          classDate: entry.classDate,
          ...(entry.releaseNote ? { releaseNote: entry.releaseNote } : {}),
        },
        {
          book: (t, classId, waitlist, signal) => backend.book(t, classId, waitlist, signal),
          resolveClassId: (planned) =>
            backend.resolveClassId(tokens!, subscription, planned.classDate),
          tokens,
          logger,
          config: timings,
          dryRun: config.dryRun,
          ...(clock.now ? { now: clock.now } : {}),
          ...(clock.sleep ? { sleep: clock.sleep } : {}),
          ...(clock.deadlineMs !== undefined ? { deadlineMs: clock.deadlineMs } : {}),
        },
      );

      await config.repo.appendHistory(userId, {
        atMs: nowMs,
        subscriptionId: subscription.id,
        className: subscription.className,
        classDate: entry.classDate,
        startTime: subscription.startTime,
        outcome: report.outcome.kind,
        ...('detail' in report.outcome ? { detail: report.outcome.detail } : {}),
        attempts: report.attempts,
        firstAttemptOffsetMs: report.firstAttemptOffsetMs,
        dryRun: report.dryRun,
      });

      await notifyChat(config.telegramBotToken, profile.telegramChatId, describeReport(report));
      handled += 1;
    }
  }

  return handled;
}

/** Nightly: reproject every linked profile, and drop releases long past. */
export async function runReindex(
  config: AppConfig,
  nowMs: number = Date.now(),
): Promise<number> {
  const logger = new Logger();
  const profiles = await config.repo.listLinkedProfiles();

  let indexed = 0;
  for (const profile of profiles) {
    indexed += await reindexProfile(config, profile, nowMs);
  }

  const pruned = await config.repo.pruneDueEntries(nowMs - 24 * 60 * 60 * 1000);
  logger.log('cron.reindex', { profiles: profiles.length, indexed, pruned });
  return indexed;
}
