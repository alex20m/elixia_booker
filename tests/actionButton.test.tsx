// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActionButton } from '@/app/components/ActionButton';

/**
 * The button that knows it is working.
 *
 * Two failures live here, and the second is the expensive one. A control that
 * looks unpressed for a second reads as broken — but a control that accepts the
 * second press sends the request twice, and "twice" for the buttons wearing
 * this component means a duplicate DELETE, a duplicate subscription, or a
 * second login attempt against Elixia's rate limiter.
 *
 * The double-press guard is the reason these tests dispatch two clicks without
 * a render in between: that is what a double-tap on a phone is, and a guard
 * that only consults the rendered `disabled` attribute misses it entirely.
 */

let container: HTMLDivElement;
let root: Root;

/** A promise a test finishes by hand, so the pending state can be inspected. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const button = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('#act')!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('a button whose work takes a moment', () => {
  it('says what it is doing, and refuses to be pressed again, until the work finishes', async () => {
    const held = deferred();
    let calls = 0;

    await act(async () => {
      root.render(
        <ActionButton
          id="act"
          pendingLabel="Removing…"
          onClick={() => {
            calls += 1;
            return held.promise;
          }}
        >
          Remove
        </ActionButton>,
      );
    });

    expect(button().textContent).toBe('Remove');
    expect(button().disabled).toBe(false);

    await act(async () => {
      button().click();
    });

    expect(calls).toBe(1);
    expect(button().textContent).toContain('Removing…');
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.spinner')).not.toBeNull();

    await act(async () => {
      held.resolve();
      await held.promise;
    });

    expect(button().textContent).toBe('Remove');
    expect(button().disabled).toBe(false);
    expect(button().hasAttribute('aria-busy')).toBe(false);
  });

  it('sends one request for a double-tap, not two', async () => {
    // Both clicks land before React can re-render the button as disabled,
    // which is exactly what an impatient thumb produces.
    const held = deferred();
    let calls = 0;

    await act(async () => {
      root.render(
        <ActionButton id="act" onClick={() => {
          calls += 1;
          return held.promise;
        }}>
          Remove
        </ActionButton>,
      );
    });

    await act(async () => {
      button().click();
      button().click();
    });

    expect(calls).toBe(1);

    await act(async () => {
      held.resolve();
      await held.promise;
    });
  });

  it('hands a failure to the caller and becomes pressable again', async () => {
    // A failed save that leaves its button dead forever is worse than one that
    // never showed it was working.
    const errors: string[] = [];

    await act(async () => {
      root.render(
        <ActionButton
          id="act"
          onClick={async () => {
            throw new Error('Elixia rejected those credentials');
          }}
          onError={(err) => errors.push(err.message)}
        >
          Link account
        </ActionButton>,
      );
    });

    await act(async () => {
      button().click();
    });

    expect(errors).toEqual(['Elixia rejected those credentials']);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Link account');
  });

  it('stays disabled while the caller has its own reason to refuse', async () => {
    await act(async () => {
      root.render(
        <ActionButton id="act" disabled onClick={async () => {}}>
          Add class
        </ActionButton>,
      );
    });

    expect(button().disabled).toBe(true);
  });
});
