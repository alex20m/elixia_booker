import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { satisfies } from 'semver';

/**
 * The dependency tree has to agree with itself about which React it is running
 * on.
 *
 * `npm install` does not fail when it disagrees — it prints an "ERESOLVE
 * overriding peer dependency" warning, installs the tree anyway, and leaves a
 * package built against React 18 rendering inside a React 19 app. That warning
 * scrolls past in CI and on every developer's machine, so the mismatch is
 * checked here instead, from the lockfile, with no install and no network.
 */

type LockPackage = {
  version?: string;
  link?: boolean;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const lock = JSON.parse(
  readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
) as { packages: Record<string, LockPackage> };

/**
 * Where node's resolution would find `dep` for the package installed at `key`:
 * its own node_modules first, then each enclosing one, ending at the root. The
 * same walk npm uses when it decides a nested copy satisfies a peer.
 */
function resolutionPath(key: string, dep: string): string[] {
  const paths: string[] = [];
  let scope = key;
  for (;;) {
    paths.push(scope === '' ? `node_modules/${dep}` : `${scope}/node_modules/${dep}`);
    const nested = scope.lastIndexOf('/node_modules/');
    if (nested === -1) break;
    scope = scope.slice(0, nested);
  }
  paths.push(`node_modules/${dep}`);
  return [...new Set(paths)];
}

function resolve(key: string, dep: string): { at: string; version: string } | undefined {
  for (const at of resolutionPath(key, dep)) {
    const version = lock.packages[at]?.version;
    if (version) return { at, version };
  }
  return undefined;
}

const reactPeers = Object.entries(lock.packages).flatMap(([key, pkg]) =>
  key === '' || pkg.link
    ? []
    : Object.entries(pkg.peerDependencies ?? {})
        .filter(([dep]) => dep === 'react' || dep === 'react-dom')
        .map(([dep, range]) => ({
          key,
          dep,
          range,
          optional: pkg.peerDependenciesMeta?.[dep]?.optional === true,
        })),
);

describe('React peer dependencies', () => {
  it('installs a single React at the root of the tree', () => {
    // Everything below assumes one React for the whole app. Two copies is its
    // own bug — hooks throw across the boundary — so catch it here rather than
    // silently checking each package against a different one.
    const reacts = Object.keys(lock.packages).filter((key) => key.endsWith('node_modules/react'));
    expect(reacts).toEqual(['node_modules/react']);
  });

  it('has packages declaring a React peer to check', () => {
    // Guards the check below from passing because it found nothing to look at.
    expect(reactPeers.length).toBeGreaterThan(0);
  });

  it('gives every package a React that satisfies the range it asked for', () => {
    const mismatched = reactPeers.flatMap(({ key, dep, range, optional }) => {
      const resolved = resolve(key, dep);
      // An optional peer that is genuinely absent is the package being used
      // without its React integration, which is fine.
      if (!resolved) return optional ? [] : [`${key} wants ${dep}@${range}, which is not installed`];
      return satisfies(resolved.version, range)
        ? []
        : [`${key} wants ${dep}@${range}, but resolves to ${resolved.version} at ${resolved.at}`];
    });

    expect(mismatched).toEqual([]);
  });
});
