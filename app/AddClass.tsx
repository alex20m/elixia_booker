'use client';

import { useEffect, useState } from 'react';
import { apiRequest as api, titleCase } from '@/lib/dashboardState';
import type { CenterOption, ClassOption } from '@/lib/types';

/**
 * Picking a class, from the classes that exist.
 *
 * This used to be four free-text fields, and every one of them could be wrong
 * in a way nothing noticed: a misremembered class name, a centre spelled the
 * way people say it rather than the way Elixia lists it, a time that is close
 * to a real one. The subscription looked fine in the list, and then failed to
 * resolve at T-0 every single week — the app's quietest possible failure,
 * since "not listed yet" is also what a class looks like before its window
 * opens.
 *
 * So the form is now built from the live schedule: centres come from Elixia's
 * own filter, classes from the timetable that centre publishes, and the
 * weekday and start time are properties of the slot that was picked rather
 * than three fields a user has to keep consistent with each other. The server
 * checks the same thing again — this is a chooser, not the guard.
 */

/**
 * A list fetched from the server.
 *
 * Modelled as one value with a state, rather than a list plus flags, because
 * "empty" and "not loaded yet" and "failed" all render as *nothing* if they
 * are allowed to collapse into each other — and an empty picker with no
 * explanation is the failure that looks like a broken page.
 */
type Remote<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string };

async function fetchRemote<T>(load: () => Promise<T>): Promise<Remote<T>> {
  try {
    return { status: 'ready', value: await load() };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}

export default function AddClass({ refresh }: { refresh: () => Promise<void> }) {
  const [centers, setCenters] = useState<Remote<CenterOption[]>>({ status: 'loading' });
  /** Elixia's numeric club id: filtering by it skips a whole page fetch. */
  const [pickedCenter, setPickedCenter] = useState('');
  /**
   * A centre named by hand, for when the list does not have it.
   *
   * Held separately from what is being typed so a keystroke does not fire a
   * ~1.5MB schedule fetch — nothing is looked up until it is submitted.
   */
  const [manual, setManual] = useState(false);
  const [typed, setTyped] = useState('');
  const [namedCenter, setNamedCenter] = useState('');
  // Tagged with the centre it describes, so a timetable is never read as
  // belonging to a centre it was not fetched for — the same trick the
  // dashboard plays with the signed-in user, and for the same reason: without
  // it, the previous centre's classes stay pickable until the next response
  // lands.
  const [loaded, setLoaded] = useState<{ center: string; remote: Remote<ClassOption[]> } | null>(
    null,
  );
  /** Index into the loaded classes; '' means nothing picked yet. */
  const [picked, setPicked] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // One key for both routes: an id from the list, or whatever was named by
  // hand. Everything downstream — the fetch, the tagging, the reset on change
  // — works the same either way.
  const center = manual ? namedCenter : pickedCenter;

  useEffect(() => {
    let active = true;
    void fetchRemote(async () =>
      (await api<{ centers: CenterOption[] }>('/api/catalog')).centers,
    ).then((result) => {
      if (active) setCenters(result);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!center) return;

    // `active` matters here beyond tidiness: changing centre twice quickly
    // could otherwise land the first centre's timetable after the second's.
    let active = true;
    void fetchRemote(async () =>
      (
        await api<{ classes: ClassOption[] }>(
          `/api/catalog?center=${encodeURIComponent(center)}`,
        )
      ).classes,
    ).then((remote) => {
      if (active) setLoaded({ center, remote });
    });

    return () => {
      active = false;
    };
  }, [center]);

  // Anything not tagged with the selected centre is still on its way, which is
  // what makes the switch immediate rather than one render behind.
  const classes: Remote<ClassOption[]> | null = !center
    ? null
    : loaded?.center === center
      ? loaded.remote
      : { status: 'loading' };
  const options = classes?.status === 'ready' ? classes.value : [];
  const chosen = picked === '' ? undefined : options[Number(picked)];
  // Stored by name, browsed by id: the name is what a person recognises in
  // their own list of classes, and what a subscription has always carried. A
  // hand-named centre is stored exactly as it was entered, since that is the
  // only spelling anything here knows.
  const centerName = manual
    ? namedCenter
    : ((centers.status === 'ready' ? centers.value : []).find((c) => c.id === center)?.name ?? '');

  const submitTyped = (): void => {
    setPicked('');
    setError('');
    setNamedCenter(typed.trim());
  };

  return (
    <div className="card">
      <h2>Add a class</h2>
      <div className="row row-2">
        <div>
          <label htmlFor={manual ? 's-center-manual' : 's-center'}>Centre</label>
          {manual ? (
            <div className="row row-2" style={{ gap: 8 }}>
              <input
                id="s-center-manual"
                placeholder="Circus, or a club id like 741"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitTyped();
                }}
              />
              <button id="center-manual-find" className="ghost" onClick={submitTyped}>
                Find classes
              </button>
            </div>
          ) : (
            <select
              id="s-center"
              value={pickedCenter}
              disabled={centers.status !== 'ready'}
              onChange={(e) => {
                setPickedCenter(e.target.value);
                setPicked('');
                setError('');
              }}
            >
              <option value="">{centerPlaceholder(centers)}</option>
              {centers.status === 'ready' &&
                centers.value.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          )}
        </div>
        <div>
          <label htmlFor="s-class">Class</label>
          <select
            id="s-class"
            value={picked}
            disabled={options.length === 0}
            onChange={(e) => {
              setPicked(e.target.value);
              setError('');
            }}
          >
            <option value="">{classPlaceholder(center, classes)}</option>
            {options.map((option, index) => (
              <option key={`${option.className}|${option.weekday}|${option.startTime}`} value={index}>
                {option.className} · {titleCase(option.weekday)} {option.startTime}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="sub" style={{ margin: '10px 0 0', fontSize: 13 }}>
        <button
          id="center-manual-toggle"
          className="ghost"
          style={{ padding: 0, border: 0, background: 'none', textDecoration: 'underline' }}
          onClick={() => {
            setManual(!manual);
            setPicked('');
            setError('');
          }}
        >
          {manual ? 'Choose from the list instead' : "My centre isn't listed"}
        </button>
      </p>

      {centers.status === 'error' && <div className="banner banner-err">{centers.message}</div>}
      {classes?.status === 'error' && <div className="banner banner-err">{classes.message}</div>}
      {error && <div className="banner banner-err">{error}</div>}

      <button
        id="add-btn"
        disabled={busy || !chosen}
        onClick={async () => {
          if (!chosen) return;
          setError('');
          setBusy(true);
          try {
            await api('/api/subscriptions', {
              method: 'POST',
              body: JSON.stringify({
                className: chosen.className,
                center: centerName,
                weekday: chosen.weekday,
                startTime: chosen.startTime,
              }),
            });
            setPicked('');
            await refresh();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Adding…' : 'Add class'}
      </button>
      <p className="sub" style={{ margin: '14px 0 0', fontSize: 13 }}>
        Only classes Elixia currently publishes can be added — its schedule runs about two
        weeks ahead, and a weekly class appears in it every week.
      </p>
    </div>
  );
}

function centerPlaceholder(centers: Remote<CenterOption[]>): string {
  if (centers.status === 'loading') return 'Loading centres…';
  if (centers.status === 'error') return 'Could not load centres';
  return 'Choose a centre';
}

function classPlaceholder(center: string, classes: Remote<ClassOption[]> | null): string {
  if (!center) return 'Choose a centre first';
  if (!classes || classes.status === 'loading') return 'Loading classes…';
  if (classes.status === 'error') return 'Could not load classes';
  return classes.value.length === 0 ? 'No classes published here' : 'Choose a class';
}
