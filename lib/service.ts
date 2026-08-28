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

import {
  API_DISCOVERED,
  ElixiaClient,
  normalizeTime,
  WEEK_ORDER,
  type BookingBackend,
} from './elixia';
import { MockElixiaClient } from './mock';
import { importEncryptionKey, decryptJson, encryptJson, DecryptionError } from './auth/crypto';
import { DuplicateSubscriptionError } from './db/repo';
import { releasesFor, releasesInRange } from './planner';
import { executeBooking, describeReport } from './booking';
import { Logger } from './logger';
import { notifyUser } from './notify';
import { isMembershipWindow } from './membership';
import { isOfferedTimeZone } from './timezones';
import {
  LINK_TOKEN_TTL_MS,
  TOKEN_PATTERN,
  hashLinkToken,
  isValidChatId,
  newLinkToken,
  telegramDeepLink,
} from './telegramLink';
import { DEFAULT_TIMINGS } from './config';
import { createLimiter, type Limiter } from './concurrency';
import { needsRefresh } from './tokens';
import { isConfigured, UnknownCenterError, WEEKDAYS } from './types';
import type { AppConfig } from './appConfig';
import type {
  BookingConfig,
  BookingHistoryEntry,
  CenterOption,
  ClassOption,
  ConfiguredProfile,
  DueEntry,
  NotifyChannel,
  Profile,
  SealedElixiaSecret,
  StoredTokens,
  Subscription,
  Weekday,
} from './types';

/** How far ahead the reindex projects. Weekly classes recur well inside this. */
export const REINDEX_HORIZON_DAYS = 10;

export function backendFor(config: AppConfig): BookingBackend {
  return config.backend ?? (config.mock ? new MockElixiaClient() : new ElixiaClient());
}

export function timingConfig(profile: ConfiguredProfile): BookingConfig {
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
export async function getOrCreateProfile(config: AppConfig, userId: string): Promise<Profile> {
  const existing = await config.repo.getProfile(userId);
  if (existing) return existing;

  // Empty on purpose. Nothing here is guessed — not the booking window, not
  // the timezone, and not even the notification address the session is holding
  // right now, because storing that would settle the channel question by
  // implication. `completeSetup` is the only writer of any of them.
  const profile: Profile = { id: userId, elixiaStatus: 'unlinked' };
  await config.repo.upsertProfile(profile);
  return profile;
}

/**
 * Wipe everything the app itself stored for this user — profile, sealed
 * Elixia secret, subscriptions, scheduled releases, history.
 *
 * Called from the Neon Auth proxy once the identity itself has actually been
 * deleted (see app/api/auth/[...path]/route.ts). Neon Auth is managed
 * remotely and offers no hook of its own to run this from, and the schema
 * has no foreign key back to it either — see db/migrations/0001_initial_schema.sql
 * — so this is the one place that keeps a deleted account from leaving its
 * gym credentials and subscriptions behind indefinitely.
 */
export async function deleteAccount(config: AppConfig, userId: string): Promise<void> {
  await config.repo.deleteProfile(userId);
}

// --- setup -----------------------------------------------------------------

/**
 * What the browser is told when the account is not ready to be used.
 *
 * 428 Precondition Required, not 400 or 403: nothing is wrong with the request
 * or the session — a precondition of the account has not been met. The client
 * routes on the status alone, so every guarded endpoint sends a visitor to the
 * setup pages without each one having to say so in its own words.
 */
export const SETUP_REQUIRED_STATUS = 428;
const SETUP_REQUIRED_MESSAGE = 'Finish setting up your account first';

/**
 * Narrow a profile to one that has been through setup, or refuse.
 *
 * Every caller that computes a release instant or sends a message needs all
 * three settings, and this is where "the user has not chosen yet" stops being
 * something each of them has to remember to handle.
 */
export function requireConfigured(profile: Profile): ConfiguredProfile {
  if (!isConfigured(profile)) throw new ServiceError(SETUP_REQUIRED_MESSAGE, SETUP_REQUIRED_STATUS);
  return profile;
}

/** What the setup pages need to know before they can ask anything. */
export interface SetupState {
  /** Whether the pages have to be shown at all. */
  needed: boolean;
  /**
   * The address this account signed in with, offered on the notifications
   * page. A suggestion is not a default: it is prefilled into a field the user
   * still has to see and submit, and nothing is stored until they do.
   */
  suggestedEmail: string;
  /** Whether this deployment can offer the one-tap Telegram connect flow. */
  telegramConnect: boolean;
  /** The chat already connected, so the page can show that step as done. */
  telegramChatId: string;
}

export function setupState(config: AppConfig, profile: Profile, sessionEmail?: string): SetupState {
  return {
    needed: !isConfigured(profile),
    suggestedEmail: profile.notifyEmail ?? sessionEmail ?? '',
    telegramConnect: telegramConnectConfigured(config),
    telegramChatId: profile.telegramChatId ?? '',
  };
}

/**
 * Finish setup: store the answers, and let the app start.
 *
 * Validated as one submission rather than page by page, because the pages are
 * one decision in three parts and a half-applied setup is the state this whole
 * design exists to prevent. Nothing is written unless all of it passes.
 */
export async function completeSetup(
  config: AppConfig,
  profile: Profile,
  input: SettingsInput,
  nowMs: number,
): Promise<ConfiguredProfile> {
  const checked = readSettings(profile, input, true);

  const updated: ConfiguredProfile = {
    ...profile,
    bookingWindowDays: checked.bookingWindowDays,
    timeZone: checked.timeZone,
    notifyChannel: checked.notifyChannel,
    ...(checked.notifyEmail ? { notifyEmail: checked.notifyEmail } : { notifyEmail: undefined }),
    ...(checked.telegramChatId
      ? { telegramChatId: checked.telegramChatId }
      : { telegramChatId: undefined }),
    configuredAtMs: profile.configuredAtMs ?? nowMs,
  };

  await config.repo.upsertProfile(updated);
  // A profile that had no window and no zone has nothing computed yet, and
  // both of them decide when a release fires.
  await reindexProfile(config, updated, nowMs);
  return updated;
}

// --- notification channels -------------------------------------------------

const NOTIFY_CHANNELS: readonly NotifyChannel[] = ['email', 'telegram', 'none'];

/**
 * Deliberately permissive: the authority on whether an address works is the
 * mail that reaches it, and a stricter pattern rejects real addresses. This
 * only catches what is plainly not one, so nobody saves a typo and waits for
 * alerts that were never deliverable.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_CHARS = 254;

/**
 * Whether this deployment can offer the one-tap connect flow.
 *
 * All three are needed and each fails differently without the others: no
 * username and there is no link to send anyone to, no token and nothing can be
 * sent, no webhook secret and the endpoint that learns the chat id refuses
 * every caller. Where it is false the UI falls back to asking for a chat id by
 * hand, which is how deployments configured before any of this still work.
 */
export function telegramConnectConfigured(config: AppConfig): boolean {
  return Boolean(
    config.telegramBotToken && config.telegramBotUsername && config.telegramWebhookSecret,
  );
}

/**
 * Begin connecting a Telegram chat: mint a token, remember its hash, and hand
 * back the deep link that carries it.
 *
 * The token travels to Telegram and comes back through the webhook, which is
 * what ties an anonymous `/start` to this account — see lib/telegramLink.ts.
 */
export async function startTelegramLink(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
): Promise<{ url: string; expiresAtMs: number }> {
  if (!config.telegramBotUsername) {
    throw new ServiceError(
      'This deployment has no Telegram bot configured. Set TELEGRAM_BOT_USERNAME, ' +
        'TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.',
      500,
    );
  }

  const token = newLinkToken();
  const expiresAtMs = nowMs + LINK_TOKEN_TTL_MS;
  await config.repo.createTelegramLink(profile.id, hashLinkToken(token), expiresAtMs, nowMs);

  return { url: telegramDeepLink(config.telegramBotUsername, token), expiresAtMs };
}

/**
 * Finish connecting: spend the token and bind the chat that presented it.
 *
 * Called from the public webhook, so it treats every input as hostile and
 * answers with the same 'expired' for an unknown token, a spent one, an
 * expired one and a malformed one. Distinguishing them would tell a caller
 * probing the endpoint which of its guesses had once been real.
 *
 * Connecting also switches the user to Telegram, because tapping Connect is
 * the choice — asking them to come back to Settings and pick the channel again
 * would leave the common case one silent step short of working.
 */
export async function completeTelegramLink(
  config: AppConfig,
  token: string,
  chatId: string,
  nowMs: number,
): Promise<'linked' | 'expired'> {
  if (!TOKEN_PATTERN.test(token)) return 'expired';

  const userId = await config.repo.claimTelegramLink(hashLinkToken(token), nowMs);
  if (!userId) return 'expired';

  const profile = await config.repo.getProfile(userId);
  if (!profile) return 'expired';

  await config.repo.upsertProfile({
    ...profile,
    telegramChatId: chatId,
    notifyChannel: 'telegram',
  });
  return 'linked';
}

/**
 * Tell a user something, and write down when that did not happen.
 *
 * The send's result used to be discarded. That made every silent failure mode
 * indistinguishable from "nothing to report": a revoked bot token, a user who
 * blocked the bot, an unverified sender domain — each stops every alert
 * permanently, and the first one anybody would have missed is the alert saying
 * booking itself had stopped. The send stays best-effort, because the booking
 * it describes has already happened; what changes is that the reason survives
 * in the log.
 */
async function announce(
  config: AppConfig,
  profile: Profile,
  logger: Logger,
  text: string,
): Promise<void> {
  const result = await notifyUser(config, profile, text);
  if (result.sent) return;

  logger.log('notify.unsent', {
    userId: profile.id,
    channel: profile.notifyChannel ?? 'unset',
    reason: result.reason ?? 'unknown',
  });
}

/**
 * Forget a connected chat.
 *
 * The channel is left where the user put it, rather than being moved to email
 * on their behalf: this app does not choose channels for people, and silently
 * rerouting a gym schedule to an inbox nobody nominated is exactly the kind of
 * helpful guess it exists to avoid. What it leaves behind — Telegram selected
 * with no chat attached — is a state the dashboard says out loud, and `notifyUser`
 * records as unsent rather than papering over.
 */
export async function disconnectTelegram(config: AppConfig, profile: Profile): Promise<Profile> {
  const updated: Profile = { ...profile, telegramChatId: undefined };
  await config.repo.upsertProfile(updated);
  return updated;
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

/**
 * A usable Elixia session for this profile, renewed and re-sealed if needed.
 *
 * Shared by the cron and by anything that browses the schedule, so a session
 * is renewed the same way everywhere — and, crucially, *persisted* when it is,
 * rather than each caller quietly logging in again on the next request.
 *
 * Throws rather than returning null: every caller needs the session to do
 * anything at all, and the two of them want very different things to happen
 * when it cannot be had (the cron marks the link dead and notifies; a browsing
 * request just says so), which is why that handling stays with them.
 */
async function elixiaSession(
  config: AppConfig,
  profile: Profile,
  backend: BookingBackend,
  nowMs: number,
): Promise<StoredTokens> {
  const secret = await openSecret(config, profile);
  let tokens = secret.tokens;

  if (!tokens || needsRefresh(tokens, nowMs)) {
    tokens = tokens?.refreshToken
      ? await backend
          .refresh(tokens, nowMs)
          .catch(() => backend.login(profile.elixiaEmail ?? '', secret.password, nowMs))
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

  return tokens;
}

/**
 * Run something against the live schedule, with every failure turned into a
 * status the browser can act on.
 *
 * The distinction that matters is between "you asked for something that does
 * not exist" (400, and retrying will not help) and "Elixia could not be
 * reached" (502, and it might) — collapsing the two would either send someone
 * hunting for a typo during an outage, or tell them to try again forever.
 */
async function browsingSchedule<T>(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
  fn: (backend: BookingBackend, tokens: StoredTokens) => Promise<T>,
): Promise<T> {
  const backend = backendFor(config);
  const tokens = await elixiaSession(config, profile, backend, nowMs).catch((err) => {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(
      `Elixia would not accept your saved credentials (${(err as Error).message}). Re-link your gym account.`,
      401,
    );
  });

  try {
    return await fn(backend, tokens);
  } catch (err) {
    if (err instanceof UnknownCenterError) throw new ServiceError(err.message, 400);
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(
      `Could not read Elixia's schedule right now (${(err as Error).message}). Try again in a moment.`,
      502,
    );
  }
}

/** Every centre a class can be chosen from. */
export async function listCenters(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
): Promise<CenterOption[]> {
  return browsingSchedule(config, profile, nowMs, (backend, tokens) => backend.listCenters(tokens));
}

/**
 * Every weekly slot published for one centre — the only classes that may be
 * subscribed to.
 *
 * What it can offer is bounded by what Elixia publishes (~14 days, the same
 * for everyone), which is more than a week, so every weekly slot appears at
 * least once.
 */
export async function listClasses(
  config: AppConfig,
  profile: Profile,
  center: string,
  nowMs: number,
): Promise<ClassOption[]> {
  const trimmed = center.trim();
  if (!trimmed) throw new ServiceError('Pick a centre first', 400);
  return browsingSchedule(config, profile, nowMs, (backend, tokens) =>
    backend.listClasses(tokens, trimmed),
  );
}

// --- dashboard -------------------------------------------------------------

export interface DashboardView {
  account: {
    bookingWindowDays: number;
    timeZone: string;
    notifyChannel: NotifyChannel;
    notifyEmail: string;
    telegramChatId: string;
    elixiaEmail: string;
    elixiaStatus: Profile['elixiaStatus'];
  };
  /**
   * Whether this deployment can offer the one-tap connect flow. False falls
   * the UI back to asking for a chat id by hand.
   */
  telegramConnect: boolean;
  subscriptions: Array<Subscription & { nextReleaseAt: string | null }>;
  history: BookingHistoryEntry[];
  dryRun: boolean;
  apiDiscovered: boolean;
  mock: boolean;
  ephemeralStore: boolean;
}

export async function buildDashboard(
  config: AppConfig,
  profile: ConfiguredProfile,
  nowMs: number,
): Promise<DashboardView> {
  const subscriptions = await config.repo.listSubscriptions(profile.id);
  const timings = timingConfig(profile);

  // Monday first, then by time, so the dashboard reads like a timetable
  // rather than the order classes happened to be added in.
  const byWeek = [...subscriptions].sort(
    (a, b) =>
      WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday) ||
      a.startTime.localeCompare(b.startTime),
  );

  return {
    account: {
      bookingWindowDays: profile.bookingWindowDays,
      timeZone: profile.timeZone,
      notifyChannel: profile.notifyChannel,
      notifyEmail: profile.notifyEmail ?? '',
      telegramChatId: profile.telegramChatId ?? '',
      elixiaEmail: profile.elixiaEmail ?? '',
      elixiaStatus: profile.elixiaStatus,
    },
    subscriptions: byWeek.map((s) => {
      const next = releasesFor(
        { ...s, bookingWindowDays: s.bookingWindowDays ?? profile.bookingWindowDays },
        nowMs,
        timings,
      ).find((r) => r.releaseEpochMs > nowMs);
      return { ...s, nextReleaseAt: next ? new Date(next.releaseEpochMs).toISOString() : null };
    }),
    telegramConnect: telegramConnectConfigured(config),
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

  if (!className) throw new ServiceError('Class name is required', 400);
  if (!center) throw new ServiceError('Centre is required', 400);
  if (!WEEKDAYS.includes(weekday)) throw new ServiceError('Pick a valid weekday', 400);
  if (!/^\d{1,2}:\d{2}$/.test(startTime)) {
    throw new ServiceError('Start time must look like 09:00', 400);
  }

  // Checked against the live schedule, not just against the chooser that
  // offered it: a class that is not published cannot be resolved at T-0, so
  // accepting one would add a row that books nothing and says nothing until
  // the user notices weeks later that they never got in.
  const offered = await listClasses(config, profile, center, nowMs);
  const match = offered.find((option) =>
    isSameClass(option, { className, weekday, startTime }),
  );

  if (!match) {
    throw new ServiceError(
      `"${className}" at ${normalizeTime(startTime)} is not on ${center}'s schedule on ` +
        `${weekday}. Pick a class from the list — Elixia publishes about two weeks ahead.`,
      400,
    );
  }

  const existing = await config.repo.listSubscriptions(profile.id);

  let subscription: Subscription;
  try {
    subscription = await config.repo.createSubscription({
      userId: profile.id,
      // The listing's own spelling and padding, not the submitted one: booking
      // matches these against the schedule exactly, so "bodypump" or "9:00"
      // would resolve to nothing on the day.
      className: match.className,
      center,
      weekday,
      startTime: match.startTime,
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

/** What the setup pages and the settings form both submit. */
export interface SettingsInput {
  bookingWindowDays?: unknown;
  timeZone?: unknown;
  notifyChannel?: unknown;
  notifyEmail?: unknown;
  telegramChatId?: unknown;
}

/** The settings a submission decides, once every one of them has been checked. */
interface CheckedSettings {
  bookingWindowDays: number;
  timeZone: string;
  notifyChannel: NotifyChannel;
  notifyEmail: string | undefined;
  telegramChatId: string | undefined;
}

/**
 * Validate a submission against the lists the user was actually offered.
 *
 * Shared by setup and by the settings form so the two cannot drift: a value
 * the setup pages would refuse must not become storable by saving it again
 * from Settings, which is how an app with no defaults acquires one.
 *
 * `demandEverything` is the difference between them. Setup insists on all
 * three answers, because that is the whole point of it. A later save treats a
 * field the request does not carry as "not part of this form" rather than as a
 * reset: a caller sending only a booking window must not thereby move a
 * Telegram user onto email, wipe their address, or disconnect their chat.
 */
function readSettings(
  profile: Profile,
  input: SettingsInput,
  demandEverything: boolean,
): CheckedSettings {
  const bookingWindowDays =
    input.bookingWindowDays === undefined && !demandEverything
      ? profile.bookingWindowDays
      : Number(input.bookingWindowDays);

  if (!isMembershipWindow(bookingWindowDays)) {
    throw new ServiceError(
      'Choose a membership: Basic / Flexible books 7 days ahead, Premium 14',
      400,
    );
  }

  const timeZone =
    input.timeZone === undefined && !demandEverything ? profile.timeZone : input.timeZone;

  // Checked against the list rather than against `Intl`: a zone can be real,
  // resolvable, and still not one this app offered, which means it did not
  // come from the picker and nobody has seen it spelled out on screen.
  if (!isOfferedTimeZone(timeZone)) {
    throw new ServiceError('Pick a timezone from the list', 400);
  }

  const rawChannel =
    input.notifyChannel === undefined && !demandEverything
      ? profile.notifyChannel
      : String(input.notifyChannel ?? '').trim();

  const notifyChannel = rawChannel as NotifyChannel;
  if (!NOTIFY_CHANNELS.includes(notifyChannel)) {
    throw new ServiceError('Choose where booking alerts should go', 400);
  }

  let notifyEmail = profile.notifyEmail;
  if (input.notifyEmail !== undefined) {
    const raw = String(input.notifyEmail).trim();
    if (raw && (raw.length > EMAIL_MAX_CHARS || !EMAIL_PATTERN.test(raw))) {
      throw new ServiceError('That does not look like an email address', 400);
    }
    notifyEmail = raw || undefined;
  }

  // The chat id normally arrives through the connect flow, but a deployment
  // without the webhook still needs the manual field to work, blank included.
  let telegramChatId = profile.telegramChatId;
  if (input.telegramChatId !== undefined) {
    const raw = String(input.telegramChatId).trim();
    if (!raw) {
      telegramChatId = undefined;
    } else if (!isValidChatId(raw)) {
      throw new ServiceError(
        'A Telegram chat ID is a number, not a username — connect the chat instead',
        400,
      );
    } else {
      telegramChatId = raw;
    }
  }

  // Checked against the values that will actually be stored, so choosing a
  // channel with nowhere to send is refused even though each half looks fine
  // alone. Accepting it would leave someone believing they are covered while
  // every alert — including the one saying booking has stopped — is dropped.
  //
  // Only when the request actually concerns notifications, though: a save that
  // moves a timezone must not be rejected over a chat that was disconnected
  // days ago and is not on the form in front of the user.
  const touchesNotifications =
    demandEverything || input.notifyChannel !== undefined || input.notifyEmail !== undefined;

  if (touchesNotifications && notifyChannel === 'email' && !notifyEmail) {
    throw new ServiceError(
      'Add an email address to send notifications to, or choose another channel',
      400,
    );
  }
  if (touchesNotifications && notifyChannel === 'telegram' && !telegramChatId) {
    throw new ServiceError(
      'Connect your Telegram chat before choosing it, or choose another channel',
      400,
    );
  }

  return { bookingWindowDays, timeZone, notifyChannel, notifyEmail, telegramChatId };
}

export async function updateSettings(
  config: AppConfig,
  profile: ConfiguredProfile,
  input: SettingsInput,
  nowMs: number,
): Promise<ConfiguredProfile> {
  const checked = readSettings(profile, input, false);

  const updated: ConfiguredProfile = {
    ...profile,
    bookingWindowDays: checked.bookingWindowDays,
    timeZone: checked.timeZone,
    notifyChannel: checked.notifyChannel,
    ...(checked.notifyEmail ? { notifyEmail: checked.notifyEmail } : { notifyEmail: undefined }),
    ...(checked.telegramChatId
      ? { telegramChatId: checked.telegramChatId }
      : { telegramChatId: undefined }),
  };

  await config.repo.upsertProfile(updated);
  // Both the window and the zone move release instants, so the schedule must be
  // rebuilt or the cron would fire at the old times.
  await reindexProfile(config, updated, nowMs);
  return updated;
}

/** The longest a centre name or club id may plausibly be. */
const MAX_DEFAULT_LENGTH = 120;

/**
 * The centre this user last chose a class from, as the chooser wants it.
 *
 * An empty string rather than an absent field: the chooser compares it against
 * the clubs the live filter offers today, and `''` matches nothing, which is
 * exactly the behaviour a never-chosen — or since-closed — centre should have.
 */
export interface CenterDefaults {
  center: string;
}

export function centerDefaults(profile: Profile): CenterDefaults {
  return { center: profile.defaultCenter ?? '' };
}

/**
 * Remember the centre, so the next visit starts at the same gym.
 *
 * A blank clears it, which is what a chooser reset back to no centre means —
 * there is no state where forgetting has to be expressed some other way.
 *
 * Deliberately no reindex, unlike `updateSettings`: which centre someone
 * browses from moves no release instant, and rebuilding the schedule on every
 * dropdown change would be real work done for nothing.
 */
export async function saveCenterDefaults(
  config: AppConfig,
  profile: Profile,
  input: { center?: unknown },
): Promise<Profile> {
  const center = String(input.center ?? '').trim();
  if (center.length > MAX_DEFAULT_LENGTH) {
    throw new ServiceError('That centre is too long to be a real one', 400);
  }

  const updated: Profile = {
    ...profile,
    ...(center ? { defaultCenter: center } : { defaultCenter: undefined }),
  };

  await config.repo.upsertProfile(updated);
  return updated;
}

export async function planFor(
  config: AppConfig,
  profile: ConfiguredProfile,
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
/**
 * Whether a published slot is the class a subscription means.
 *
 * The same triple `findClassId` matches on at T-0, minus the date — so if this
 * says no, booking will fail to resolve it too. Kept in one place because two
 * slightly different answers to "is this the same class?" would mean the
 * chooser accepting something the nightly check then flags, or the reverse.
 */
export function isSameClass(
  option: ClassOption,
  wanted: { className: string; weekday: string; startTime: string },
): boolean {
  return (
    option.className.trim().toLowerCase() === wanted.className.trim().toLowerCase() &&
    option.weekday === wanted.weekday &&
    option.startTime === normalizeTime(wanted.startTime)
  );
}

/**
 * Check each of a profile's classes against the published timetable, and
 * record the ones that have gone.
 *
 * This exists because of how invisible the failure is otherwise. Elixia
 * withdrawing a class does not delete anything here: the subscription stays,
 * `resolveClassId` finds nothing at T-0, and the attempt is recorded as
 * `too-early` — the very same outcome as a class whose booking window has not
 * opened yet. Weeks of "Missed" can pass without a sign that the class simply
 * no longer runs.
 *
 * Three properties matter more than the check itself:
 *
 *   * **One read per centre**, not per class. The timetable is a ~1.5MB page.
 *   * **An unreadable centre changes nothing.** A night when Elixia is down
 *     must not mark every class of every user as withdrawn — the flag would
 *     be worthless the first time it fired wrongly, so a failed read leaves
 *     that centre's classes exactly as they were.
 *   * **The first absence is what is kept**, so the dashboard can say "gone
 *     since Tuesday" rather than "gone since today", every day.
 *
 * Paused classes are skipped: they are not booking, so nothing is silently
 * failing for them, and warning about one would be noise.
 */
export async function reviewListedClasses(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
): Promise<void> {
  if (profile.elixiaStatus !== 'ok') return;

  const subscriptions = (await config.repo.listSubscriptions(profile.id)).filter((s) => s.enabled);
  const centers = [...new Set(subscriptions.map((s) => s.center))];
  const logger = new Logger();

  for (const center of centers) {
    let offered: ClassOption[];
    try {
      offered = await listClasses(config, profile, center, nowMs);
    } catch (err) {
      // Deliberately not a flag: "we could not look" is not "it is gone".
      logger.log('listing.check.failed', {
        userId: profile.id,
        center,
        error: (err as Error).message,
      });
      continue;
    }

    for (const subscription of subscriptions.filter((s) => s.center === center)) {
      const listed = offered.some((option) => isSameClass(option, subscription));

      if (listed) {
        if (subscription.unlistedSinceMs !== undefined) {
          await config.repo.setSubscriptionUnlisted(profile.id, subscription.id, null);
        }
        continue;
      }

      // Already flagged: keep the original date and stay quiet. The owner has
      // been told once; telling them nightly is how a warning becomes noise.
      if (subscription.unlistedSinceMs !== undefined) continue;

      await config.repo.setSubscriptionUnlisted(profile.id, subscription.id, nowMs);
      logger.log('listing.withdrawn', {
        userId: profile.id,
        subscriptionId: subscription.id,
        className: subscription.className,
      });
      await announce(
        config,
        profile,
        logger,
        `⚠️ ${subscription.className} · ${subscription.weekday} ${subscription.startTime} ` +
          `at ${subscription.center} is no longer on Elixia's schedule, so it cannot be booked. ` +
          `It may have been renamed, moved or dropped — check the timetable and update it here.`,
      );
    }
  }
}

export async function reindexProfile(
  config: AppConfig,
  profile: Profile,
  nowMs: number,
  horizonDays = REINDEX_HORIZON_DAYS,
): Promise<number> {
  // An unconfigured profile has no window and no zone, so there is no instant
  // to compute — and nothing to compute it for, since linking a gym account is
  // itself behind setup.
  if (!isConfigured(profile) || profile.elixiaStatus !== 'ok') {
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
 * How much of a tick's *off-race* work may run at once.
 *
 * Preparation and follow-up are gated so a busy release minute cannot open one
 * database connection and one gym login per user simultaneously; the race to
 * T-0 never is. See lib/concurrency.ts for why gating the race would be the
 * bug rather than the fix.
 */
const TICK_CONCURRENCY = 8;

/** Everything one user's bookings need in hand before the release instant. */
interface PreparedUser {
  profile: ConfiguredProfile;
  subscriptions: Subscription[];
  tokens: StoredTokens;
}

/**
 * Book everything due right now, across all users.
 *
 * The window spans the previous, current and next minute: the next minute gives
 * the handler lead time to prepare a session before sleeping to the exact
 * instant, and the previous one means a tick that fires late still finds the
 * slot rather than skipping it.
 *
 * **Every due booking races on its own.** This used to be one loop — user after
 * user, class after class — which quietly made a release a queue: the second
 * user's booking did not begin its sleep to T-0 until the first user's had
 * finished retrying, written history and sent a notification. One user retrying
 * for ten seconds pushed everyone behind them ten seconds past the instant they
 * were promised, and the further down the loop you were, the worse it got.
 * There is no ordering here worth that: the bookings are independent, and the
 * whole design of lib/booking.ts is that nothing stands between T-0 and the
 * POST. So preparation runs for all users at once, every booking then sleeps to
 * its own release, and history and notifications happen afterwards, off
 * everyone else's critical path.
 */
export async function runDueBookings(
  config: AppConfig,
  nowMs: number = Date.now(),
  clock: TickClock = {},
): Promise<number> {
  const logger = new Logger(clock.now);
  const entries = await config.repo.claimDue(nowMs - MINUTE_MS, nowMs + MINUTE_MS, nowMs);
  logger.log('cron.tick', { dueCount: entries.length });
  if (entries.length === 0) return 0;

  const byUser = new Map<string, DueEntry[]>();
  for (const entry of entries) {
    byUser.set(entry.userId, [...(byUser.get(entry.userId) ?? []), entry]);
  }

  const backend = backendFor(config);
  const gate = createLimiter(TICK_CONCURRENCY);

  const handledPerUser = await Promise.all(
    [...byUser].map(([userId, userEntries]) =>
      bookForUser(config, backend, gate, userId, userEntries, nowMs, clock),
    ),
  );

  return handledPerUser.reduce((total, n) => total + n, 0);
}

/**
 * One user's share of a tick: prepare once, then race every entry at once.
 *
 * Failures are contained here rather than propagating. Now that users run
 * concurrently, letting one rejection out of `Promise.all` would abandon
 * everybody else's bookings mid-race — a database hiccup reading one profile
 * would cost every other user their slot, which is precisely the coupling this
 * function exists to remove.
 */
async function bookForUser(
  config: AppConfig,
  backend: BookingBackend,
  gate: Limiter,
  userId: string,
  entries: DueEntry[],
  nowMs: number,
  clock: TickClock,
): Promise<number> {
  const logger = new Logger(clock.now);

  let loaded: PreparedUser | null;
  try {
    loaded = await gate(() => prepareUser(config, backend, logger, userId, nowMs));
  } catch (err) {
    logger.log('user.failed', { userId, stage: 'prepare', error: (err as Error).message });
    return 0;
  }
  if (!loaded) return 0;

  const prepared = loaded;
  const results = await Promise.all(
    entries.map((entry) => bookEntry(config, backend, gate, prepared, entry, nowMs, clock)),
  );

  return results.filter(Boolean).length;
}

/**
 * Load the profile, its classes and a live gym session.
 *
 * Returns null when this user has nothing to do — the two "skip quietly"
 * cases below — and throws only when something unexpected went wrong.
 */
async function prepareUser(
  config: AppConfig,
  backend: BookingBackend,
  logger: Logger,
  userId: string,
  nowMs: number,
): Promise<PreparedUser | null> {
  const profile = await config.repo.getProfile(userId);
  // Unconfigured is not merely unusual here, it is unreachable: linking a gym
  // account is behind setup, and a due entry only exists for a linked one.
  // Skipping rather than defaulting keeps it that way — a release computed
  // from a guessed timezone fires at the wrong minute and books nothing.
  if (!profile || !isConfigured(profile) || profile.elixiaStatus !== 'ok') return null;

  const subscriptions = await config.repo.listSubscriptions(userId);

  // Prepare the session before sleeping to T-0, never during the race.
  let tokens;
  try {
    tokens = await elixiaSession(config, profile, backend, nowMs);
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
    await announce(
      config,
      profile,
      logger,
      '🚨 Elixia rejected your saved credentials and booking is paused. Re-link your account to resume.',
    );
    return null;
  }

  return { profile, subscriptions, tokens };
}

/**
 * Race one release, then record it.
 *
 * The logger is per-booking, not shared with the rest of the tick: every line
 * it writes is stamped with its offset from *this* booking's T-0, and two
 * bookings running side by side have two different T-0s. A shared logger would
 * measure one booking's lines against the other's release instant, which turns
 * the one number the log exists to report into a lie.
 */
async function bookEntry(
  config: AppConfig,
  backend: BookingBackend,
  gate: Limiter,
  prepared: PreparedUser,
  entry: DueEntry,
  nowMs: number,
  clock: TickClock,
): Promise<boolean> {
  const { profile, subscriptions, tokens } = prepared;
  const subscription = subscriptions.find((s) => s.id === entry.subscriptionId);
  // The schedule is derived data; live subscriptions are the authority.
  if (!subscription || !subscription.enabled) return false;

  const logger = new Logger(clock.now);

  try {
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
        book: (t, classId, signal) => backend.book(t, classId, signal),
        resolveClassId: (planned) => backend.resolveClassId(tokens, subscription, planned.classDate),
        tokens,
        logger,
        config: timingConfig(profile),
        dryRun: config.dryRun,
        ...(clock.now ? { now: clock.now } : {}),
        ...(clock.sleep ? { sleep: clock.sleep } : {}),
        ...(clock.deadlineMs !== undefined ? { deadlineMs: clock.deadlineMs } : {}),
      },
    );

    // Gated: the slot is already won or lost by now, and a hundred users all
    // writing history and sending mail at once is load nobody is waiting on.
    await gate(async () => {
      await config.repo.appendHistory(profile.id, {
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

      await announce(config, profile, logger, describeReport(report));
    });

    return true;
  } catch (err) {
    logger.log('booking.failed', {
      userId: profile.id,
      subscriptionId: subscription.id,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Nightly: reproject every linked profile, and drop releases long past. */
export interface ReindexOptions {
  /**
   * Wall-clock instant the run must be finished by, so the listing review can
   * be abandoned rather than the whole invocation being killed mid-flight.
   */
  deadlineMs?: number;
}

export async function runReindex(
  config: AppConfig,
  nowMs: number = Date.now(),
  options: ReindexOptions = {},
): Promise<number> {
  const logger = new Logger();
  const profiles = await config.repo.listLinkedProfiles();

  // Two passes, and the order is the point. Indexing is database-only and
  // fast; reviewing reads a ~1.5MB page per centre per profile, inside a
  // function with a hard duration cap. Interleaved, one slow night would kill
  // the invocation partway through and leave every profile after that point
  // with no computed releases — booking nothing at all, which is a far worse
  // failure than an unreviewed listing. So every profile is indexed first,
  // and the review is what gets dropped when the clock runs out.
  let indexed = 0;
  for (const profile of profiles) {
    indexed += await reindexProfile(config, profile, nowMs);
  }

  let reviewed = 0;
  for (const profile of profiles) {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) break;
    await reviewListedClasses(config, profile, nowMs);
    reviewed += 1;
  }

  const pruned = await config.repo.pruneDueEntries(nowMs - 24 * 60 * 60 * 1000);
  logger.log('cron.reindex', {
    profiles: profiles.length,
    indexed,
    pruned,
    reviewed,
    // Persistently non-zero means the job is outgrowing its window: the
    // profiles at the end of the list are never getting reviewed.
    reviewSkipped: profiles.length - reviewed,
  });
  return indexed;
}
