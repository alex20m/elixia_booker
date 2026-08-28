// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let search = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useSearchParams: () => search,
}));

const { AuthNotice } = await import('@/app/auth/AuthNotice');

/**
 * What a verification link that did not work says.
 *
 * The proxy settles the link and then sends the browser to /auth/sign-in with
 * the reason on the query string, so this component is the only thing standing
 * between the visitor and a link that silently did nothing. The codes come
 * from Better Auth, and the one thing that must never happen is showing one:
 * "INVALID_TOKEN" is not an explanation, and an unrecognised code has to
 * degrade to a sentence rather than to nothing at all.
 */

let container: HTMLDivElement;
let root: Root;

const render = (query: string): void => {
  search = new URLSearchParams(query);
  act(() => {
    root.render(<AuthNotice />);
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the auth notice', () => {
  it('says a link has expired, in words', () => {
    render('error=TOKEN_EXPIRED');

    const notice = container.querySelector('#auth-notice');
    expect(notice?.textContent).toMatch(/expired/i);
    expect(notice?.textContent).not.toMatch(/TOKEN_EXPIRED/);
  });

  it('says a link was already used when that is what happened', () => {
    render('error=INVALID_TOKEN');

    expect(container.querySelector('#auth-notice')?.textContent).toMatch(/already been used/i);
  });

  it('still explains itself when the code is one it has never seen', () => {
    render('error=SOMETHING_NEW');

    const notice = container.querySelector('#auth-notice');
    expect(notice?.textContent).toMatch(/did not work/i);
    expect(notice?.textContent).not.toMatch(/SOMETHING_NEW/);
  });

  it('says nothing at all on an ordinary visit to the sign-in page', () => {
    render('');

    expect(container.querySelector('#auth-notice')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
