'use client';

import { useEffect, useState } from 'react';
import { apiRequest as api, titleCase } from '@/lib/dashboardState';
import type { CenterDefaults } from '@/lib/service';
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
 *
 * The centre is reached the way the schedule page's own filter groups it:
 * country, then city, then club. That is not decoration — the filter carries
 * every club in the group, 226 of them, and one flat dropdown of that length
 * is a list nobody finds their own gym in. The three answers are also the same
 * every week for anyone who trains where they train, so each is saved as it is
 * picked and offered back next time.
 *
 * The class is deliberately not among what is saved. It is the one thing being
 * decided here, and a prefilled one is a subscription nobody meant to create.
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

/** First occurrence wins, so the catalogue's own ordering is kept. */
const distinct = (values: string[]): string[] => [...new Set(values)];

export default function AddClass({ refresh }: { refresh: () => Promise<void> }) {
  const [centers, setCenters] = useState<Remote<CenterOption[]>>({ status: 'loading' });
  /** The cascade down to a club: each one narrows what the next may offer. */
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
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
        // A place that cannot be read is a lost convenience, not a broken
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
     * Re-walk a saved place against the list Elixia offers *today*.
     *
     * Each step is applied only if it still exists, and the club's current
     * country and city are preferred over the saved spellings — a club that
     * was refiled under another city should reopen where it is now, and a club
     * that has closed should leave the cascade as far along as it can still
     * legitimately go rather than selecting nothing or something wrong.
     */
    function applySaved(options: CenterOption[], saved: CenterDefaults): void {
      const club = options.find((option) => option.id === saved.center);
      if (club) {
        setCountry(club.country);
        setCity(club.city);
        setCenter(club.id);
        return;
      }

      if (!options.some((option) => option.country === saved.country)) return;
      setCountry(saved.country);
      if (options.some((o) => o.country === saved.country && o.city === saved.city)) {
        setCity(saved.city);
      }
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
  // The catalogue arrives sorted by country, city and name, so narrowing it
  // keeps that order without sorting anything again here.
  const countries = distinct(all.map((option) => option.country));
  const cities = distinct(
    all.filter((option) => option.country === country).map((option) => option.city),
  );
  const inCity = all.filter((option) => option.country === country && option.city === city);

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
   * Remember the place, at every step rather than only on a completed add.
   *
   * All three values go together and a blank clears, so what comes back can
   * always be re-walked in order: saving a country without clearing the city
   * under the old one would hand the next visit a cascade whose steps
   * contradict each other.
   *
   * Nothing is awaited and a failure is swallowed on purpose. This is the
   * memory of a choice, not the choice — the form works either way, and an
   * error banner about a preference would sit next to a class that added
   * perfectly well.
   */
  const remember = (next: CenterDefaults): void => {
    void api('/api/preferences', { method: 'PUT', body: JSON.stringify(next) }).catch(() => {});
  };

  const chooseCountry = (value: string): void => {
    setCountry(value);
    setCity('');
    setCenter('');
    setPicked('');
    setError('');
    remember({ country: value, city: '', center: '' });
  };

  const chooseCity = (value: string): void => {
    setCity(value);
    setCenter('');
    setPicked('');
    setError('');
    remember({ country, city: value, center: '' });
  };

  const chooseCenter = (value: string): void => {
    setCenter(value);
    setPicked('');
    setError('');
    remember({ country, city, center: value });
  };

  return (
    <div className="card">
      <h2>Add a class</h2>
      <div className="row row-3">
        <div>
          <label htmlFor="s-country">Country</label>
          <select
            id="s-country"
            value={country}
            disabled={centers.status !== 'ready'}
            onChange={(e) => chooseCountry(e.target.value)}
          >
            <option value="">{countryPlaceholder(centers)}</option>
            {countries.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="s-city">City</label>
          <select
            id="s-city"
            value={city}
            disabled={!country}
            onChange={(e) => chooseCity(e.target.value)}
          >
            <option value="">{country ? 'Choose a city' : 'Choose a country first'}</option>
            {cities.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="s-center">Centre</label>
          <select
            id="s-center"
            value={center}
            disabled={!city}
            onChange={(e) => chooseCenter(e.target.value)}
          >
            <option value="">{city ? 'Choose a centre' : 'Choose a city first'}</option>
            {inCity.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="row">
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

function countryPlaceholder(centers: Remote<CenterOption[]>): string {
  if (centers.status === 'loading') return 'Loading centres…';
  if (centers.status === 'error') return 'Could not load centres';
  return 'Choose a country';
}

function classPlaceholder(center: string, classes: Remote<ClassOption[]> | null): string {
  if (!center) return 'Choose a centre first';
  if (!classes || classes.status === 'loading') return 'Loading classes…';
  if (classes.status === 'error') return 'Could not load classes';
  return classes.value.length === 0 ? 'No classes published here' : 'Choose a class';
}
