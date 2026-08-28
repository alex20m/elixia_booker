import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The pipeline is the only reviewer this repo has: nothing else stands between a
 * merged commit and production. That makes the *shape* of the workflows —
 * what runs, and which event runs it — behaviour worth asserting, not
 * configuration to eyeball. Every check below has a one-line edit to a workflow
 * that turns it red, which is the point: silently dropping `npm test` would
 * otherwise look like a green pipeline right up until it shipped something
 * broken.
 *
 * Deploying is Vercel's Git integration, not Actions. That is a guarantee the
 * tests hold too — a deploy job added here would be a second route to
 * production racing the first, so the workflows are asserted to contain none.
 */

type Step = { name?: string; run?: string; uses?: string; if?: string };

type Job = {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
};

type Workflow = {
  on?: Record<string, { branches?: string[] } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const PULL_REQUEST = 'pull-request.yml';
const MAIN = 'main.yml';

function read(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../.github/workflows/${file}`, import.meta.url)), 'utf8');
}

/** The two workflows that gate a change, as text and as parsed YAML. */
const sources: Record<string, string> = {
  [PULL_REQUEST]: read(PULL_REQUEST),
  [MAIN]: read(MAIN),
};

const workflows: Record<string, Workflow> = Object.fromEntries(
  Object.entries(sources).map(([file, text]) => [file, parse(text) as Workflow]),
);

/** Fails loudly on a renamed file rather than quietly asserting about nothing. */
function workflowOf(file: string): Workflow {
  const workflow = workflows[file];
  if (workflow === undefined) {
    throw new Error(`no workflow "${file}" (found: ${Object.keys(workflows).join(', ')})`);
  }
  return workflow;
}

/** Fails loudly on a renamed job rather than quietly asserting about nothing. */
function jobOf(file: string, jobId: string): Job {
  const jobs = workflowOf(file).jobs;
  const job = jobs[jobId];
  if (job === undefined) {
    throw new Error(`${file} has no job "${jobId}" (found: ${Object.keys(jobs).join(', ')})`);
  }
  return job;
}

/** Every shell command a job runs, joined, so a check can ask "does it do X?". */
function commandsOf(workflow: Workflow, jobId: string): string {
  return (workflow.jobs[jobId]?.steps ?? []).map((step) => step.run ?? '').join('\n');
}

/**
 * Jobs that would push a build to Vercel, found by what they run rather than by
 * name, so one added later under any name is still caught.
 */
function deployingJobIds(workflow: Workflow): string[] {
  return Object.keys(workflow.jobs).filter((id) =>
    /\bvercel(?:@\S+)?\s+(?:deploy|build)\b/.test(commandsOf(workflow, id)),
  );
}

/** Jobs that apply schema migrations, found the same way. */
function migratingJobIds(workflow: Workflow): string[] {
  return Object.keys(workflow.jobs).filter((id) =>
    /\bnpm run migrate\b/.test(commandsOf(workflow, id)),
  );
}

describe('workflow triggers', () => {
  it('runs the pull-request workflow only on pull requests', () => {
    // Parsed under YAML 1.2, so the `on:` key stays a string rather than
    // collapsing to the boolean `true` that YAML 1.1 would give.
    expect(Object.keys(workflowOf(PULL_REQUEST).on ?? {})).toEqual(['pull_request']);
  });

  it('runs the main workflow only on pushes to main and on demand', () => {
    const triggers = workflowOf(MAIN).on ?? {};
    expect(Object.keys(triggers).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(triggers.push?.branches).toEqual(['main']);
  });

  it('grants both workflows read-only access to the repository by default', () => {
    for (const [file, workflow] of Object.entries(workflows)) {
      expect(workflow.permissions, `${file} must be read-only by default`).toEqual({
        contents: 'read',
      });
    }
  });
});

describe('the verify job', () => {
  it('installs from the lockfile rather than resolving fresh versions', () => {
    // `npm install` would let a transitive upgrade land in CI that nobody
    // committed, so the checks would not be testing the tree Vercel builds.
    for (const [file, workflow] of Object.entries(workflows)) {
      const commands = commandsOf(workflow, 'verify');
      expect(commands, `${file} must install from the lockfile`).toContain('npm ci');
      expect(commands, `${file} must not resolve fresh versions`).not.toMatch(/npm install\b/);
    }
  });

  it('lints, typechecks, tests and builds', () => {
    // Both workflows carry the same gate: a pull request and the merge of that
    // same pull request must be held to identical checks.
    for (const [file, workflow] of Object.entries(workflows)) {
      const commands = commandsOf(workflow, 'verify');
      expect(commands, `${file} must lint`).toContain('npm run lint');
      expect(commands, `${file} must typecheck`).toContain('npm run typecheck');
      expect(commands, `${file} must test`).toContain('npm test');
      expect(commands, `${file} must build`).toContain('npm run build');
    }
  });

  it('reports every failing check in one run instead of stopping at the first', () => {
    // Without this, a lone typecheck error hides whether the tests also broke,
    // and each fix costs another full round-trip through the pipeline.
    for (const file of Object.keys(workflows)) {
      const later = (jobOf(file, 'verify').steps ?? []).filter((step) =>
        /npm (?:test|run (?:lint|typecheck|build))/.test(step.run ?? ''),
      );
      expect(later.length, `${file} must run four checks`).toBeGreaterThanOrEqual(4);
      for (const step of later) {
        expect(step.if, `${file}: "${step.name}" must run even after an earlier failure`).toBe(
          '${{ !cancelled() }}',
        );
      }
    }
  });
});

describe('deploying', () => {
  it('recognises a job that deploys to Vercel', () => {
    // The two assertions below match nothing by design, so they would pass
    // vacuously if the detector were broken — a regex for `vercel deploy` does
    // not match `npx vercel@latest deploy`. This proves it still fires.
    const fixture = parse(
      [
        'jobs:',
        '  ship:',
        '    steps:',
        '      - run: npx --yes vercel@latest deploy --prebuilt --prod',
        '  checks:',
        '    steps:',
        '      - run: npm test',
        // Reading the project's environment variables is not deploying — the
        // migration job does exactly this, and must not be caught by it.
        '  read-env:',
        '    steps:',
        '      - run: npx --yes vercel@latest pull --yes --environment=production',
      ].join('\n'),
    ) as Workflow;
    expect(deployingJobIds(fixture)).toEqual(['ship']);
  });

  it('leaves deploying to Vercel’s own Git integration', () => {
    // Two routes to production means every merge deploys twice, racing itself,
    // and a rollback on one side is silently undone by the other.
    for (const [file, workflow] of Object.entries(workflows)) {
      expect(deployingJobIds(workflow), `${file} must not deploy — Vercel does`).toEqual([]);
    }
  });

  it('keeps Vercel credentials out of the workflows entirely', () => {
    // Nothing in Actions deploys or migrates any more, so nothing needs a
    // Vercel token. A stray one is how a second route to production returns
    // — "the secret is already there".
    for (const [file, text] of Object.entries(sources)) {
      expect(text, `${file} must not reference Vercel credentials`).not.toMatch(
        /VERCEL_(?:TOKEN|ORG_ID|PROJECT_ID)/,
      );
    }
  });
});

describe('migrations', () => {
  it('runs migrations as part of the Vercel build, before anything is served', () => {
    // This is the ordering guarantee. Vercel builds a deployment and only
    // promotes it if the build exits 0, so putting the migration inside the
    // build means the schema is in place before the new code takes a single
    // request — and a failed migration leaves the previous deployment serving
    // rather than promoting code its schema cannot support.
    const config = JSON.parse(
      readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'),
    ) as { buildCommand?: string };

    // `&&` and not `;`: with a semicolon the build would proceed over a failed
    // migration, which is the exact failure this arrangement exists to prevent.
    expect(config.buildCommand).toMatch(/npm run migrate\s*&&\s*(?:npm run build|next build)/);
  });

  it('keeps the migration out of `npm run build`', () => {
    // The checks run `npm run build`, and they have no database. A migrate
    // folded into that script would make CI need one — and would migrate from
    // a developer's laptop on every local build.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts.build).not.toMatch(/migrate/);
    expect(pkg.scripts.migrate, 'the build command above invokes this').toBeDefined();
  });

  it('recognises a job that applies migrations', () => {
    // The assertion below matches nothing by design; this proves the detector
    // it relies on still fires.
    const fixture = parse(
      [
        'jobs:',
        '  schema:',
        '    steps:',
        '      - run: npm run migrate',
        '  checks:',
        '    steps:',
        '      - run: npm test',
      ].join('\n'),
    ) as Workflow;
    expect(migratingJobIds(fixture)).toEqual(['schema']);
  });

  it('no longer migrates from a workflow', () => {
    // Two migrators is one more than the schema needs, and the workflow one
    // could only ever run after Vercel had already deployed the new code.
    for (const [file, workflow] of Object.entries(workflows)) {
      expect(migratingJobIds(workflow), `${file} must leave migrating to the build`).toEqual([]);
    }
  });
});

describe('the booking watcher', () => {
  // The only mechanism driving booking timing — see that workflow's own
  // header comment for why a long-running job replaces a per-minute trigger.
  const watch = parse(
    readFileSync(fileURLToPath(new URL('../.github/workflows/watch.yml', import.meta.url)), 'utf8'),
  ) as Workflow & { jobs: Record<string, Job & { 'timeout-minutes'?: number }> };

  it('starts on a schedule loose enough that trigger jitter cannot matter', () => {
    // The whole point: the trigger only has to land sometime before the next
    // release, not on it, so GitHub queueing the schedule is no longer on
    // the critical path for timing.
    const schedule = (watch.on as { schedule?: { cron: string }[] } | undefined)?.schedule;
    expect(schedule?.[0]?.cron).not.toBe('* * * * *');
  });

  it('does not schedule on the hour, GitHub’s own worst time for schedule delay', () => {
    // GitHub documents that scheduled triggers are most likely to be delayed
    // — or dropped outright — at the start of every hour, since that's when
    // load across all of Actions peaks. A watcher scheduled at minute 0 can
    // go multiple cycles with no run ever created (not queued, not failed,
    // just absent), leaving no watcher awake for hours: this happened for
    // real and cost a missed booking. Picking any other minute avoids that
    // shared peak.
    const schedule = (watch.on as { schedule?: { cron: string }[] } | undefined)?.schedule;
    const minuteField = schedule?.[0]?.cron.split(' ')[0];
    expect(minuteField).not.toBe('0');
  });

  it('never lets two watchers race for the same release', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../.github/workflows/watch.yml', import.meta.url)),
      'utf8',
    );
    expect(text).toMatch(/cancel-in-progress:\s*false/);
  });

  it('stops itself comfortably inside GitHub’s 6-hour job ceiling', () => {
    // A job GitHub kills mid-sleep exits with nothing recorded; one that
    // stops on its own terms lets the queued next run take over cleanly.
    const timeout = watch.jobs.watch?.['timeout-minutes'];
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(360);
  });

  it('polls the peek endpoint rather than claiming a release just to check on it', () => {
    // /api/cron/next only reads; claiming early would take the release away
    // from whichever caller is actually meant to fire it.
    const commands = commandsOf(watch, 'watch');
    expect(commands).toMatch(/\/api\/cron\/next/);
  });
});

describe('the booking watchdog', () => {
  // A cheap, frequent safety net for the watcher above: GitHub can drop a
  // scheduled trigger outright rather than just delay it (see the watcher's
  // own header comment for the incident that proved it), and when that
  // happens nothing else notices — no failed run, nothing queued, just an
  // absent one. This checks whether a watcher is currently active and
  // re-dispatches one when it isn't, on a much tighter cadence than the
  // watcher's own.
  const watchdogText = readFileSync(
    fileURLToPath(new URL('../.github/workflows/watchdog.yml', import.meta.url)),
    'utf8',
  );
  const watchdog = parse(watchdogText) as Workflow & {
    jobs: Record<string, Job & { 'timeout-minutes'?: number }>;
  };

  it('checks hourly, far tighter than the watcher’s own 3-hour cadence', () => {
    // Bounds how long a dropped watcher trigger can go unnoticed to about an
    // hour instead of up to three.
    const schedule = (watchdog.on as { schedule?: { cron: string }[] } | undefined)?.schedule;
    const [minute, hour] = schedule?.[0]?.cron.split(' ') ?? [];
    expect(hour).toBe('*');
    expect(minute).not.toBe('*');
  });

  it('lands on a different minute than the watcher, so one load spike can’t drop both', () => {
    const watcher = parse(
      readFileSync(fileURLToPath(new URL('../.github/workflows/watch.yml', import.meta.url)), 'utf8'),
    ) as Workflow;
    const watcherMinute = (watcher.on as { schedule?: { cron: string }[] } | undefined)?.schedule?.[0]?.cron.split(
      ' ',
    )[0];
    const watchdogMinute = (watchdog.on as { schedule?: { cron: string }[] } | undefined)?.schedule?.[0]?.cron.split(
      ' ',
    )[0];

    expect(watchdogMinute).toBeDefined();
    expect(watchdogMinute).not.toBe(watcherMinute);
  });

  it('only re-dispatches when no watcher run is active, rather than piling on regardless', () => {
    // A blind dispatch every hour would just be a second, uncoordinated
    // scheduler. The concurrency group on watch.yml would absorb the excess,
    // but the check should still gate the action rather than fire blindly.
    const commands = commandsOf(watchdog, 'watchdog');
    expect(commands).toMatch(/gh run list/);
    expect(commands).toMatch(/gh workflow run/);
    expect(commands).toMatch(/if\s*\[\s*"\$active"\s*-eq 0\s*\]/);
  });

  it('has only the permission it needs to list and dispatch runs', () => {
    expect(watchdog.permissions).toEqual({ actions: 'write' });
  });

  it('stops itself quickly rather than lingering like the watcher it checks on', () => {
    const timeout = watchdog.jobs.watchdog?.['timeout-minutes'];
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(10);
  });
});
