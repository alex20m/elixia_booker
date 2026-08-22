/**
 * Runtime configuration, read from the environment.
 *
 * Everything downstream takes an explicit `AppConfig`, which keeps the booking
 * logic testable without touching `process.env`.
 */

import { createMemoryRepo } from './db/memoryRepo';
import type { BookingBackend } from './elixia';
import type { Repo } from './db/repo';

export interface AppConfig {
  repo: Repo;
  /** base64 32 bytes. Seals stored Elixia credentials. */
  encryptionKey: string;
  telegramBotToken?: string;
  dryRun: boolean;
  mock: boolean;
  defaultBookingWindowDays: number;
  defaultTimeZone: string;
  /** Shared secret the cron endpoints require. */
  cronSecret?: string;
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
    dryRun: flag(process.env.DRY_RUN),
    mock: flag(process.env.MOCK_ELIXIA),
    defaultBookingWindowDays: Number(process.env.DEFAULT_BOOKING_WINDOW_DAYS ?? '7'),
    defaultTimeZone: process.env.DEFAULT_TIMEZONE ?? 'Europe/Helsinki',
    ...(process.env.CRON_SECRET ? { cronSecret: process.env.CRON_SECRET } : {}),
    ephemeralStore: options.repo === undefined,
  };
}
