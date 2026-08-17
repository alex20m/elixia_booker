import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The pipeline is the only reviewer this repo has: nothing else stands between a
 * merged commit and production. That makes the *shape* of the workflow — what
 * runs, and what a deploy is allowed to skip — behaviour worth asserting, not
 * configuration to eyeball. Every check below has a one-line edit to ci.yml that
 * turns it red, which is the point: silently dropping `npm test`, or dropping
 * the `needs:` that makes a deploy wait for it, would otherwise look like a
 * green pipeline right up until it shipped something broken.
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

const workflow = parse(
  readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8'),
) as Workflow;

const jobs = workflow.jobs;

/** Fails loudly on a renamed job rather than quietly asserting about nothing. */
function jobOf(jobId: string): Job {
  const job = jobs[jobId];
  if (job === undefined) {
    throw new Error(`ci.yml has no job "${jobId}" (found: ${Object.keys(jobs).join(', ')})`);
  }
  return job;
}

/** Every shell command a job runs, joined, so a check can ask "does it do X?". */
function commandsOf(jobId: string): string {
  return (jobOf(jobId).steps ?? []).map((step) => step.run ?? '').join('\n');
}

function needsOf(jobId: string): string[] {
  const needs = jobOf(jobId).needs;
  if (needs === undefined) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/**
 * Job ids that run a Vercel deployment, found by what they do rather than by
 * name, so a deploy job added later is held to the same rules automatically.
 */
function deployJobIds(): string[] {
  return Object.keys(jobs).filter((id) =>
    /\bvercel(?:@\S+)?\s+(?:deploy|build)\b/.test(commandsOf(id)),
  );
}

describe('CI/CD workflow triggers', () => {
  it('runs on pull requests and on pushes to main', () => {
    // Parsed under YAML 1.2, so the `on:` key stays a string rather than
    // collapsing to the boolean `true` that YAML 1.1 would give.
    const triggers = workflow.on ?? {};
    expect(Object.keys(triggers)).toEqual(
      expect.arrayContaining(['push', 'pull_request']),
    );
    expect(triggers.push?.branches).toEqual(['main']);
  });

  it('grants the workflow read-only access to the repository by default', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });
});

describe('the verify job', () => {
  it('installs from the lockfile rather than resolving fresh versions', () => {
    // `npm install` would let a transitive upgrade land in CI that nobody
    // committed, so the checks would not be testing the tree that deploys.
    const commands = commandsOf('verify');
    expect(commands).toContain('npm ci');
    expect(commands).not.toMatch(/npm install\b/);
  });

  it('lints, typechecks, tests and builds before anything else can run', () => {
    const commands = commandsOf('verify');
    expect(commands).toContain('npm run lint');
    expect(commands).toContain('npm run typecheck');
    expect(commands).toContain('npm test');
    expect(commands).toContain('npm run build');
  });

  it('reports every failing check in one run instead of stopping at the first', () => {
    // Without this, a lone typecheck error hides whether the tests also broke,
    // and each fix costs another full round-trip through the pipeline.
    const later = (jobOf('verify').steps ?? []).filter((step) =>
      /npm (?:test|run (?:lint|typecheck|build))/.test(step.run ?? ''),
    );
    expect(later.length).toBeGreaterThanOrEqual(4);
    for (const step of later) {
      expect(step.if).toBe('${{ !cancelled() }}');
    }
  });
});

describe('the deploy jobs', () => {
  it('has at least one job that deploys', () => {
    expect(deployJobIds().length).toBeGreaterThan(0);
  });

  it('makes every deploy wait for the checks to pass', () => {
    for (const id of deployJobIds()) {
      expect(needsOf(id), `job "${id}" must depend on verify`).toContain('verify');
    }
  });

  it('promotes to production only from a push to main', () => {
    const condition = jobOf('deploy-production').if ?? '';
    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.ref == 'refs/heads/main'");
  });

  it('keeps --prod out of every job except the production deploy', () => {
    // A preview deploy that carries --prod would overwrite the live site with
    // an unreviewed branch — the failure this whole gate exists to prevent.
    for (const id of deployJobIds()) {
      if (id === 'deploy-production') continue;
      expect(commandsOf(id), `job "${id}" must not deploy to production`).not.toContain('--prod');
    }
    expect(commandsOf('deploy-production')).toContain('--prod');
  });

  it('never cancels a deployment that is already in flight', () => {
    // Cancelling mid-`vercel deploy` can leave the project pointing at a build
    // that never finished, so concurrent pushes queue instead of racing.
    for (const id of deployJobIds()) {
      const concurrency = jobOf(id).concurrency;
      expect(typeof concurrency, `job "${id}" must declare concurrency`).toBe('object');
      expect((concurrency as { 'cancel-in-progress'?: boolean })['cancel-in-progress']).toBe(false);
    }
  });

  it('smoke-tests the deployment it just published', () => {
    // A build can succeed and still boot into a 500 — a missing environment
    // variable is the usual cause — so green here has to mean "it answered".
    const commands = commandsOf('deploy-production');
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
