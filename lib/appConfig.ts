/**
 * Runtime configuration, read from the environment.
 *
 * Everything downstream takes an explicit `AppConfig`, which keeps the booking
 * logic testable without touching `process.env`.
 */

import { createMemoryRepo } from './db/memoryRepo';
import { qstashTargetFor, qstashSigningKeysFor } from './qstash';
import type { BookingBackend } from './elixia';
import type { Repo } from './db/repo';

export interface AppConfig {
  repo: Repo;
  /** base64 32 bytes. Seals stored Elixia credentials. */
  encryptionKey: string;
  telegramBotToken?: string;
  /**
   * The bot's @username. Needed only to build the connect deep link — the
   * token cannot be derived from it, and it is not a secret.
   */
  telegramBotUsername?: string;
  /**
   * Shared secret Telegram echoes back on every webhook call, and the only
   * thing separating a real update from anyone else's POST to that public
   * route. Without it the connect flow stays switched off.
   */
  telegramWebhookSecret?: string;
  /** Resend API key. Email notifications are inert without one. */
  resendApiKey?: string;
  /** The verified sender notification email comes from. */
  notifyFromEmail?: string;
  dryRun: boolean;
  mock: boolean;
  // There is deliberately no default booking window and no default timezone
  // here. Both were operator-set environment variables, which made every
  // account in a deployment start life claiming the same membership tier and
  // the same city — a claim nobody made and nothing checked. They are asked
  // for during setup instead; see lib/service.ts `completeSetup`.
  /**
   * QStash API token. Without one, release instants are never published and
   * nothing drives booking at all — QStash is the only scheduler. See
   * lib/qstash.ts.
   */
  qstashToken?: string;
  /**
   * This deployment's own public origin, e.g. https://booker.example.
   *
   * Needed only because QStash calls the app from outside: a scheduled message
   * has to carry an absolute URL, and nothing else in the app has ever needed
   * to know its own address. Without it the QStash path stays dormant, since a
   * message pointed at the wrong origin fails silently at delivery time rather
   * than here.
   */
  appUrl?: string;
  /** True when running on the in-memory repo, which does not survive requests. */
  ephemeralStore: boolean;
  /**
   * Overrides which backend `backendFor` builds.
   *
   * Nothing in the app sets this — `loadAppConfig` never does — but a test
   * that needs a gym whose timetable changes mid-run has no other seam, and
   * the alternative is exporting the mock's fixture data for tests to mutate,
   * which makes every test that touches it order-dependent.
   */
  backend?: BookingBackend;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function flag(value: string | undefined): boolean {
  const v = (value ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * A single in-memory repo shared across hot reloads in dev.
 *
 * Without it every edit would drop the data. Only ever used when Neon is
 * not configured.
 */
const globalForRepo = globalThis as unknown as { __elixiaDevRepo?: Repo };

function fallbackRepo(): Repo {
  globalForRepo.__elixiaDevRepo ??= createMemoryRepo();
  return globalForRepo.__elixiaDevRepo;
}

export interface LoadOptions {
  /** Supply the repo explicitly — route handlers pass a request-bound one. */
  repo?: Repo;
}

/**
 * Whether the app can serve a signed-in request.
 *
 * Unlike the database and auth variables, nothing provisions ENCRYPTION_KEY —
 * so this is the check most likely to be false on a deployment that otherwise
 * looks healthy. /api/health reports it for exactly that reason.
 */
export function encryptionConfigured(): boolean {
  return Boolean(process.env.ENCRYPTION_KEY);
}

/**
 * Whether this deployment can actually schedule *and* receive bookings through
 * QStash — the whole round trip, not just the outbound half.
 *
 * Publishing needs the token and this deployment's own origin
 * (`qstashTargetFor`); accepting the delivery QStash then makes needs both
 * signing keys (`qstashSigningKeysFor`), because the tick endpoint
 * authenticates a QStash call by verifying its signature and nothing else.
 * Delegates to both rather than reimplementing either, so what health reports
 * and what the code does cannot drift apart.
 *
 * Reported for the same reason as `encryptionConfigured`: the path is
 * all-or-nothing, and a deployment missing any one part is the worst case —
 * messages get published and then every delivery 401s, hours later, on a path
 * nobody is watching — while looking entirely healthy from outside.
 */
export function qstashConfigured(): boolean {
  const canPublish =
    qstashTargetFor({
      qstashToken: process.env.QSTASH_TOKEN,
      appUrl: process.env.APP_URL,
    }) !== null;
  const canVerify =
    qstashSigningKeysFor({
      currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
    }) !== null;
  return canPublish && canVerify;
}

export function loadAppConfig(options: LoadOptions = {}): AppConfig {
  const encryptionKey = process.env.ENCRYPTION_KEY ?? '';

  // Fail at the edge of the system with a message that says what to do, rather
  // than surfacing a confusing crypto error three layers down.
  if (!encryptionKey) {
    throw new ConfigError('ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32');
  }

  return {
    repo: options.repo ?? fallbackRepo(),
    encryptionKey,
    ...(process.env.TELEGRAM_BOT_TOKEN
      ? { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN }
      : {}),
    ...(process.env.TELEGRAM_BOT_USERNAME
      ? { telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME }
      : {}),
    ...(process.env.TELEGRAM_WEBHOOK_SECRET
      ? { telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET }
      : {}),
    ...(process.env.RESEND_API_KEY ? { resendApiKey: process.env.RESEND_API_KEY } : {}),
    ...(process.env.NOTIFY_FROM_EMAIL ? { notifyFromEmail: process.env.NOTIFY_FROM_EMAIL } : {}),
    dryRun: flag(process.env.DRY_RUN),
    mock: flag(process.env.MOCK_ELIXIA),
    ...(process.env.QSTASH_TOKEN ? { qstashToken: process.env.QSTASH_TOKEN } : {}),
    ...(process.env.APP_URL ? { appUrl: process.env.APP_URL } : {}),
    ephemeralStore: options.repo === undefined,
  };
}
