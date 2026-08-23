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
 * The choice is made in the order a person actually makes it: where, then
 * what, then when. A single list of every published slot put those last two
 * questions in one row, so a centre running twenty classes across the week
 * offered a hundred lines to scroll, with each class scattered through them —
 * finding "the Wednesday Bodypump" meant reading past every other class to
 * find out which days Bodypump even runs. Splitting it means the class list is
 * as long as the centre has classes, and the times are only the times that one
 * class runs.
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

/**
 * How two spellings of the same class are recognised as one.
 *
 * The timetable is free text filed by whoever set the class up, so the same
 * class can arrive as "Bodypump" one day and "BODYPUMP  60" — well, "Bodypump"
 * with a stray double space — the next. Grouping on the raw string would list
 * it twice, which is exactly the duplication this step exists to remove. Same
 * normalisation the schedule parser dedupes slots with.
 */
const sameClass = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** Identifies a slot within one class, and survives the list being refetched. */
const slotKey = (option: ClassOption): string => `${option.weekday}|${option.startTime}`;

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
  /** The class being booked, as it is spelled on the timetable. */
  const [className, setClassName] = useState('');
  /** Which of that class's weekly slots, as `weekday|HH:MM`. */
  const [slot, setSlot] = useState('');
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

  // Alphabetical, not timetable order: the timetable is sorted by weekday, so
  // leaving it alone would scatter the names and put the whole point of this
  // step — finding one class by name — back where it started.
  const byName = new Map(options.map((option) => [sameClass(option.className), option.className]));
  const names = [...byName.values()].sort((a, b) => a.localeCompare(b));
  // Left in timetable order, which is weekday then time — the order a week
  // reads in.
  const slots = className
    ? options.filter((option) => sameClass(option.className) === sameClass(className))
    : [];
  const chosen = slots.find((option) => slotKey(option) === slot);
  // Stored by name, browsed by id: the name is what a person recognises in
  // their own list of classes, and what a subscription has always carried.
  const centerName = all.find((c) => c.id === center)?.name ?? '';

  /**
   * Changing the class drops the time with it.
   *
   * Not tidiness: two classes at the same centre routinely share a start time,
   * so a slot kept across the change stays a valid-looking selection and adds
   * a class on a day the new one may not run at all — the failure the whole
   * chooser exists to prevent, reintroduced by the step that was meant to make
   * it easier.
   */
  const chooseClass = (value: string): void => {
    setClassName(value);
    setSlot('');
    setError('');
  };

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
    chooseClass('');
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
          <p className="card-sub">
            Pick your gym and the class, then the weekly slot you want held.
          </p>
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
            value={className}
            disabled={names.length === 0}
            onChange={(e) => chooseClass(e.target.value)}
          >
            <option value="">{classPlaceholder(center, classes)}</option>
            {names.map((name) => (
              <option key={sameClass(name)} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field mt-s">
        <label htmlFor="s-slot">Day and time</label>
        <select
          id="s-slot"
          value={slot}
          disabled={slots.length === 0}
          onChange={(e) => {
            setSlot(e.target.value);
            setError('');
          }}
        >
          <option value="">{slotPlaceholder(className, slots.length)}</option>
          {slots.map((option) => (
            <option key={slotKey(option)} value={slotKey(option)}>
              {titleCase(option.weekday)} {option.startTime}
            </option>
          ))}
        </select>
      </div>

      {centers.status === 'error' && (
        <div className="banner banner-err mt-s">
          <span>{centers.message}</span>
        </div>
      )}
      {classes?.status === 'error' && (
        <div className="banner banner-err mt-s">
          <span>{classes.message}</span>
        </div>
      )}
      {error && (
        <div className="banner banner-err mt-s">
          <span>{error}</span>
        </div>
      )}

      <button
        id="add-btn"
        className="btn-block mt-m"
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
            chooseClass('');
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

      <p className="hint mt-s">
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

function slotPlaceholder(className: string, count: number): string {
  if (!className) return 'Choose a class first';
  // A chosen class with no slots is not reachable from the pickers — the name
  // came out of the timetable — but a class picked just as the centre changes
  // renders one frame of it, and "choose a day and time" over an empty list is
  // the same broken-looking page as before.
  return count === 0 ? 'No times published' : 'Choose a day and time';
}
