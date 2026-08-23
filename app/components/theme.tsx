'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  applyTheme,
  nextThemeChoice,
  prefersDarkNow,
  readThemeChoice,
  storeThemeChoice,
  watchPrefersDark,
  type ThemeChoice,
} from '@/lib/theme';
import { AutoIcon, MoonIcon, SunIcon } from './icons';

/**
 * The live theme choice.
 *
 * Read through `useSyncExternalStore` because that is what this is: state owned
 * by the browser, not by React. Storage is the single copy — `storeThemeChoice`
 * writes it and announces the write, this subscribes to the announcement — so
 * the header toggle and the settings control stay in step without either
 * knowing the other exists, and so does another tab.
 *
 * The server snapshot is `system`, since the server cannot see this browser's
 * storage. Nothing flashes: the blocking script in the layout has already
 * painted the page, and this value only decides which button looks pressed.
 */
function subscribeToStoredChoice(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const choice = useSyncExternalStore(
    subscribeToStoredChoice,
    () => readThemeChoice(window.localStorage),
    () => 'system' as ThemeChoice,
  );

  useEffect(() => {
    // Only meaningful while following the system, but subscribing
    // unconditionally keeps the effect free of a stale-closure special case.
    return watchPrefersDark((prefersDark) => {
      if (choice === 'system') applyTheme(document.documentElement, 'system', prefersDark);
    });
  }, [choice]);

  const choose = useCallback((next: ThemeChoice) => {
    applyTheme(document.documentElement, next, prefersDarkNow());
    // Writing announces the change, which is what re-reads the snapshot above.
    storeThemeChoice(next);
  }, []);

  return [choice, choose];
}

interface ThemeOption {
  value: ThemeChoice;
  label: string;
  icon: React.ReactNode;
}

const SYSTEM_OPTION: ThemeOption = { value: 'system', label: 'Auto', icon: <AutoIcon /> };

const OPTIONS: ThemeOption[] = [
  SYSTEM_OPTION,
  { value: 'light', label: 'Light', icon: <SunIcon /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
];

const optionFor = (choice: ThemeChoice): ThemeOption =>
  OPTIONS.find((option) => option.value === choice) ?? SYSTEM_OPTION;

/**
 * The explicit three-way control, for the settings page.
 *
 * A radiogroup rather than three buttons: these are three states of one
 * setting, and the difference is what a screen reader announces.
 */
export function ThemeChoiceControl() {
  const [choice, choose] = useThemeChoice();

  return (
    <div className="segmented" role="radiogroup" aria-label="Appearance">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          id={`theme-${option.value}`}
          type="button"
          role="radio"
          aria-checked={choice === option.value}
          className="segment"
          onClick={() => choose(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The one-tap version in the header, which cycles rather than expanding. */
export function ThemeToggle() {
  const [choice, choose] = useThemeChoice();
  const current = optionFor(choice);
  const next = nextThemeChoice(choice);

  return (
    <button
      id="theme-toggle"
      type="button"
      className="btn-icon"
      aria-label={`Theme: ${current.label}. Switch to ${optionFor(next).label}.`}
      onClick={() => choose(next)}
    >
      {current.icon}
    </button>
  );
}
