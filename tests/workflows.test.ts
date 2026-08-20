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

  it('keeps Vercel credentials to the job that reads the database URL', () => {
    // The migration job needs them for `vercel pull`; nothing else has any
    // business holding a Vercel token, and a stray one is how a deploy step
    // comes back "because the secret is already there".
    expect(sources[PULL_REQUEST], `${PULL_REQUEST} needs no Vercel credentials`).not.toMatch(
      /VERCEL_(?:TOKEN|ORG_ID|PROJECT_ID)/,
    );

    const main = workflowOf(MAIN);
    const holders = Object.keys(main.jobs).filter((id) =>
      /VERCEL_(?:TOKEN|ORG_ID|PROJECT_ID)/.test(
        JSON.stringify(main.jobs[id]?.steps ?? []),
      ),
    );
    expect(holders).toEqual(['migrate-production']);
  });
});

describe('the migration job', () => {
  it('applies migrations from the main workflow only', () => {
    // A migration is the one step of a release that cannot be rolled back, so
    // it must never run from a pull request — including one from a fork, whose
    // branch could carry any SQL at all.
    expect(migratingJobIds(workflowOf(MAIN))).toEqual(['migrate-production']);
    expect(migratingJobIds(workflowOf(PULL_REQUEST))).toEqual([]);
  });

  it('runs migrations only on a push to main', () => {
    for (const id of migratingJobIds(workflowOf(MAIN))) {
      const condition = jobOf(MAIN, id).if ?? '';
      expect(condition, `job "${id}" must be gated to main`).toContain(
        "github.event_name == 'push'",
      );
      expect(condition, `job "${id}" must be gated to main`).toContain(
        "github.ref == 'refs/heads/main'",
      );
    }
  });

  it('makes migrations wait for the checks to pass', () => {
    for (const id of migratingJobIds(workflowOf(MAIN))) {
      const needs = jobOf(MAIN, id).needs;
      expect(
        Array.isArray(needs) ? needs : [needs],
        `job "${id}" must depend on verify`,
      ).toContain('verify');
    }
  });

  it('never runs two migration jobs at once', () => {
    // Two merges landing together would otherwise race for the same schema.
    for (const id of migratingJobIds(workflowOf(MAIN))) {
      const concurrency = (jobOf(MAIN, id) as { concurrency?: unknown }).concurrency;
      expect(typeof concurrency, `job "${id}" must declare concurrency`).toBe('object');
      expect(
        (concurrency as { 'cancel-in-progress'?: boolean })['cancel-in-progress'],
      ).toBe(false);
    }
  });

  it('fails rather than migrating whatever DATABASE_URL happens to be in scope', () => {
    // The connection string comes from `vercel pull`. If it is not there, the
    // job has no business guessing — an empty DATABASE_URL and a stray one are
    // both worse than a red pipeline.
    const commands = commandsOf(workflowOf(MAIN), 'migrate-production');
    expect(commands).toMatch(/vercel(?:@\S+)?\s+pull/);
    expect(commands).toContain('DATABASE_URL');
    expect(commands).toMatch(/::error::/);
  });
});

describe('the scheduled workflows', () => {
  it('leaves the booking tick on a per-minute schedule', () => {
    // The tick is the product: a pipeline change that quietly altered its
    // cadence would break booking without failing anything.
    const cron = parse(
      readFileSync(fileURLToPath(new URL('../.github/workflows/cron.yml', import.meta.url)), 'utf8'),
    ) as { on?: { schedule?: { cron: string }[] } };
    expect(cron.on?.schedule?.[0]?.cron).toBe('* * * * *');
  });
});
