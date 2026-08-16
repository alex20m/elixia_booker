/**
 * CLI: turn raw discovery output into something safe to commit.
 *
 * Reads captures/raw/exchanges.jsonl (gitignored — live tokens) and writes
 * captures/redacted/, which keeps every endpoint, field name and status code
 * while destroying the values.
 *
 * Usage: npm run redact
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubBody, scrubHeaders, scrubUrl } from './redaction';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'captures', 'raw');
const OUT_DIR = join(ROOT, 'captures', 'redacted');

interface Exchange {
  phase: string;
  ts: string;
  method: string;
  url: string;
  status: number | null;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  [k: string]: unknown;
}

function main(): void {
  const rawLog = join(RAW_DIR, 'exchanges.jsonl');
  if (!existsSync(rawLog)) {
    console.error(`  No capture found at ${rawLog}. Run \`npm run discover:headed\` first.`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const exchanges: Exchange[] = readFileSync(rawLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Exchange);

  const redacted = exchanges.map((x) => ({
    ...x,
    url: scrubUrl(x.url),
    requestHeaders: scrubHeaders(x.requestHeaders),
    requestBody: scrubBody(x.requestBody),
    responseHeaders: scrubHeaders(x.responseHeaders),
    responseBody: scrubBody(x.responseBody),
  }));

  const outLog = join(OUT_DIR, 'exchanges.redacted.jsonl');
  writeFileSync(outLog, redacted.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

  // An endpoint index makes the capture navigable when filling in docs/api.md.
  const index = new Map<string, { phase: string; statuses: Set<number | null>; count: number }>();
  for (const x of redacted) {
    let path = x.url;
    try {
      const u = new URL(x.url);
      path = `${u.origin}${u.pathname}`;
    } catch {
      /* keep the raw string */
    }
    const key = `${x.method} ${path}`;
    const entry = index.get(key) ?? { phase: x.phase, statuses: new Set(), count: 0 };
    entry.statuses.add(x.status);
    entry.count += 1;
    index.set(key, entry);
  }

  const summary = [
    '# Endpoint index (redacted)',
    '',
    `Generated from ${exchanges.length} recorded exchanges.`,
    'Phase is the first phase in which the endpoint was seen.',
    '',
    '| Phase | Method + path | Statuses | Hits |',
    '| --- | --- | --- | --- |',
    ...[...index.entries()].map(
      ([key, v]) => `| ${v.phase} | \`${key}\` | ${[...v.statuses].join(', ')} | ${v.count} |`,
    ),
    '',
  ].join('\n');

  const outSummary = join(OUT_DIR, 'endpoint-index.md');
  writeFileSync(outSummary, summary, 'utf8');

  console.log(
    `  Redacted ${exchanges.length} exchanges across ${index.size} distinct endpoints.\n` +
      `    ${outLog}\n` +
      `    ${outSummary}\n\n` +
      `  Skim the output before committing. Redaction is heuristic, not a guarantee.\n`,
  );
}

main();
