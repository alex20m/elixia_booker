import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The pipeline is the only reviewer this repo has: nothing else stands between a
 * merged commit and production. That makes the *shape* of the workflows — what
 * runs, what a deploy is allowed to skip, and which event is allowed to promote
 * — behaviour worth asserting, not configuration to eyeball. Every check below
 * has a one-line edit to a workflow that turns it red, which is the point:
 * silently dropping `npm test`, or dropping the `needs:` that makes a deploy
 * wait for it, would otherwise look like a green pipeline right up until it
 * shipped something broken.
 *
 * Pull requests and pushes to `main` are separate workflow files so that one
 * event can never trigger the other's deploy. The tests treat them as a pair:
 * the check job is asserted in both, and a deploy job found in either is held
 * to the same rules.
 */

type Step = { name?: string; run?: string; uses?: string; if?: string };

type Job = {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  concurrency?: string | { group?: string; 'cancel-in-progress'?: boolean };
};

type Workflow = {
  on?: Record<string, { branches?: string[] } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

function load(file: string): Workflow {
  const path = fileURLToPath(new URL(`../.github/workflows/${file}`, import.meta.url));
  return parse(readFileSync(path, 'utf8')) as Workflow;
}

const PULL_REQUEST = 'pull-request.yml';
const MAIN = 'main.yml';

/** The two workflows that gate a deploy, by file name. */
const workflows: Record<string, Workflow> = {
  [PULL_REQUEST]: load(PULL_REQUEST),
  [MAIN]: load(MAIN),
};

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
function commandsOf(file: string, jobId: string): string {
  return (jobOf(file, jobId).steps ?? []).map((step) => step.run ?? '').join('\n');
}

function needsOf(file: string, jobId: string): string[] {
  const needs = jobOf(file, jobId).needs;
  if (needs === undefined) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/**
 * Jobs that run a Vercel deployment, across both workflows, found by what they
 * do rather than by name — so a deploy job added later is held to the same
 * rules automatically.
 */
function deployJobs(): { file: string; id: string }[] {
  return Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.keys(workflow.jobs)
      .filter((id) => /\bvercel(?:@\S+)?\s+(?:deploy|build)\b/.test(commandsOf(file, id)))
      .map((id) => ({ file, id })),
  );
}

describe('workflow triggers', () => {
  it('runs the pull-request workflow only on pull requests', () => {
    // Parsed under YAML 1.2, so the `on:` key stays a string rather than
    // collapsing to the boolean `true` that YAML 1.1 would give.
    expect(Object.keys(workflowOf(PULL_REQUEST).on ?? {})).toEqual(['pull_request']);
  });

  it('runs the main workflow only on pushes to main and on demand', () => {
    // A `pull_request` trigger here would deploy a branch to production; a
    // second push trigger for another branch would do the same from a fork of
    // main's history.
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
    // committed, so the checks would not be testing the tree that deploys.
    for (const file of Object.keys(workflows)) {
      const commands = commandsOf(file, 'verify');
      expect(commands, `${file} must install from the lockfile`).toContain('npm ci');
      expect(commands, `${file} must not resolve fresh versions`).not.toMatch(/npm install\b/);
    }
  });

  it('lints, typechecks, tests and builds before anything else can run', () => {
    // Both workflows carry the same gate: a pull request and the merge of that
    // same pull request must be held to identical checks.
    for (const file of Object.keys(workflows)) {
      const commands = commandsOf(file, 'verify');
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

describe('the deploy jobs', () => {
  it('deploys a preview from the pull-request workflow and production from main', () => {
    // Guards the detector itself: if it matched nothing, every loop below would
    // pass while asserting about no job at all.
    expect(deployJobs()).toEqual([
      { file: PULL_REQUEST, id: 'deploy-preview' },
      { file: MAIN, id: 'deploy-production' },
    ]);
  });

  it('makes every deploy wait for the checks to pass', () => {
    for (const { file, id } of deployJobs()) {
      expect(needsOf(file, id), `${file}: job "${id}" must depend on verify`).toContain('verify');
    }
  });

  it('promotes to production only from a push to main', () => {
    const condition = jobOf(MAIN, 'deploy-production').if ?? '';
    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.ref == 'refs/heads/main'");
  });

  it('keeps --prod out of every job except the production deploy', () => {
    // A preview deploy that carries --prod would overwrite the live site with
    // an unreviewed branch — the failure this whole gate exists to prevent.
    for (const { file, id } of deployJobs()) {
      if (id === 'deploy-production') continue;
      expect(commandsOf(file, id), `${file}: job "${id}" must not deploy to production`).not.toContain(
        '--prod',
      );
    }
    expect(commandsOf(MAIN, 'deploy-production')).toContain('--prod');
  });

  it('never cancels a deployment that is already in flight', () => {
    // Cancelling mid-`vercel deploy` can leave the project pointing at a build
    // that never finished, so concurrent pushes queue instead of racing.
    for (const { file, id } of deployJobs()) {
      const concurrency = jobOf(file, id).concurrency;
      expect(typeof concurrency, `${file}: job "${id}" must declare concurrency`).toBe('object');
      expect(
        (concurrency as { 'cancel-in-progress'?: boolean })['cancel-in-progress'],
        `${file}: job "${id}" must queue rather than cancel`,
      ).toBe(false);
    }
  });

  it('fails the run when the Vercel credentials are missing', () => {
    // These used to skip with a notice, which made a merge that never reached
    // production look exactly like one that did — the deploy is silent about
    // its own absence, so a broken secret goes unnoticed for as long as nobody
    // opens the app. Missing credentials are now a red run.
    for (const { file, id } of deployJobs()) {
      const steps = jobOf(file, id).steps ?? [];

      const gate = steps.find((step) => /VERCEL_TOKEN/.test(step.run ?? ''));
      expect(gate, `${file}: job "${id}" must check its credentials`).toBeDefined();
      expect(gate?.run, `${file}: missing credentials must fail the job`).toMatch(/exit 1\b/);

      // The old skip guarded every later step on a step output; nothing in a
      // deploy job may be conditional on the credentials being present again.
      for (const step of steps) {
        expect(step.if ?? '', `${file}: "${step.name}" must not be skipped when unconfigured`).not.toMatch(
          /configured/,
        );
      }
    }
  });

  it('smoke-tests the deployment it just published', () => {
    // A build can succeed and still boot into a 500 — a missing environment
    // variable is the usual cause — so green here has to mean "it answered".
    const commands = commandsOf(MAIN, 'deploy-production');
    expect(commands).toContain('/api/health');
    expect(commands).toMatch(/curl[^\n]*--fail/);
  });
});

describe('the scheduled workflows', () => {
  it('leaves the booking tick on a per-minute schedule', () => {
    // The tick is the product: a deploy pipeline that quietly changed its
    // cadence would break booking without failing anything.
    const cron = parse(
      readFileSync(fileURLToPath(new URL('../.github/workflows/cron.yml', import.meta.url)), 'utf8'),
    ) as { on?: { schedule?: { cron: string }[] } };
    expect(cron.on?.schedule?.[0]?.cron).toBe('* * * * *');
  });
});
