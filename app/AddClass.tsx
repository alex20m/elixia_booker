'use client';

import { useEffect, useState } from 'react';
import { apiRequest as api, titleCase } from '@/lib/dashboardState';
import type { CenterDefaults } from '@/lib/service';
import type { CenterOption, ClassOption } from '@/lib/types';
import { PlusIcon } from './components/icons';

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
 *
 * The centre is remembered between visits, because it does not change:
 * someone books at their own gym week after week, and picking it out of 226
 * clubs is a chore in front of the choice that actually matters. It was worth
 * more than that — country → city → club is how a list this long ought to be
 * navigated — but the schedule page carries no club locations to build that
 * from, so the list stays flat and the memory does the work instead.
 *
 * The class is deliberately not remembered. It is the one thing being decided
 * here, and a prefilled one is a subscription nobody meant to create.
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
  const [center, setCenter] = useState('');
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

  useEffect(() => {
    let active = true;

    // Asked for together: the remembered place is only useful alongside the
    // list it has to be matched against, and serialising them would leave the
    // form visibly re-filling itself after it had already been drawn.
    void (async () => {
      const [remote, saved] = await Promise.all([
        fetchRemote(async () => (await api<{ centers: CenterOption[] }>('/api/catalog')).centers),
        // A centre that cannot be read is a lost convenience, not a broken
        // chooser: everything still works, it just starts empty.
        api<{ defaults: CenterDefaults }>('/api/preferences')
          .then((body) => body.defaults)
          .catch(() => null),
      ]);
      if (!active) return;

      setCenters(remote);
      if (saved) applySaved(remote.status === 'ready' ? remote.value : [], saved);
    })();

    /**
     * Select the remembered centre, but only if Elixia still offers it.
     *
     * Checked against today's list rather than trusted: clubs come and go,
     * and a select whose value no option carries renders blank while the form
     * believes a centre is chosen — so it would fetch a dead club's timetable
     * and open on an error about a centre the visitor never picked.
     */
    function applySaved(options: CenterOption[], saved: CenterDefaults): void {
      if (options.some((option) => option.id === saved.center)) setCenter(saved.center);
    }

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

  const all = centers.status === 'ready' ? centers.value : [];

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
  // their own list of classes, and what a subscription has always carried.
  const centerName = all.find((c) => c.id === center)?.name ?? '';

  /**
   * Remember the centre, as soon as it is picked rather than on a completed
   * add: choosing a gym and then thinking better of the class is still the
   * same gym next week.
   *
   * Nothing is awaited and a failure is swallowed on purpose. This is the
   * memory of a choice, not the choice — the form works either way, and an
   * error banner about a preference would sit next to a class that added
   * perfectly well.
   */
  const chooseCenter = (value: string): void => {
    setCenter(value);
    setPicked('');
    setError('');
    void api('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify({ center: value } satisfies CenterDefaults),
    }).catch(() => {});
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">Add a class</h2>
          <p className="card-sub">Pick your gym, then the weekly slot you want held.</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="s-center">Centre</label>
          <select
            id="s-center"
            value={center}
            disabled={centers.status !== 'ready'}
            onChange={(e) => chooseCenter(e.target.value)}
          >
            <option value="">{centerPlaceholder(centers)}</option>
            {all.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
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
              <option
                key={`${option.className}|${option.weekday}|${option.startTime}`}
                value={index}
              >
                {option.className} · {titleCase(option.weekday)} {option.startTime}
              </option>
            ))}
          </select>
        </div>
      </div>

      {centers.status === 'error' && (
        <div className="banner banner-err" style={{ marginTop: '0.75rem' }}>
          <span>{centers.message}</span>
        </div>
      )}
      {classes?.status === 'error' && (
        <div className="banner banner-err" style={{ marginTop: '0.75rem' }}>
          <span>{classes.message}</span>
        </div>
      )}
      {error && (
        <div className="banner banner-err" style={{ marginTop: '0.75rem' }}>
          <span>{error}</span>
        </div>
      )}

      <button
        id="add-btn"
        className="btn-block"
        style={{ marginTop: '0.875rem' }}
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
        <PlusIcon />
        {busy ? 'Adding…' : 'Add class'}
      </button>

      <p className="hint" style={{ marginTop: '0.75rem' }}>
        Only classes Elixia currently publishes can be added — its schedule runs about two weeks
        ahead, and a weekly class appears in it every week.
      </p>
    </section>
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
