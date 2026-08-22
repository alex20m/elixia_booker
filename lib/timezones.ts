/**
 * The timezones a user may choose from, as a list rather than a text box.
 *
 * Why a fixed list at all, when `Intl.supportedValuesOf('timeZone')` would hand
 * back every zone the runtime knows: because a timezone here is not decoration.
 * Every release instant this app computes is a wall-clock time in *this* zone
 * turned into an epoch millisecond, so a zone that is off by an hour books an
 * hour late, and a zone that does not exist cannot book at all. A typed field
 * accepts "Europe/Helsinky" and every other near-miss silently — and the person
 * who typed it has no reason to look at it again until a class they wanted has
 * been full for weeks.
 *
 * So the list is curated, and `isOfferedTimeZone` is the server's own guard:
 * anything not on it is refused, whatever sent it. The cost is that a member in
 * a city nobody listed cannot finish setup — which is why the Nordics and the
 * Baltics, where Elixia actually has clubs, are covered city by city, and the
 * rest of the world is covered by the zone a traveller would recognise. Adding
 * a zone is a one-line change here; the tests check every id against `Intl`.
 *
 * Ids are IANA names and must stay canonical: `Intl` resolves aliases like
 * `Europe/Kiev`, but the id is what gets stored and compared, and two spellings
 * of one zone in a stored profile is a bug nobody will find twice.
 */

export interface TimeZoneOption {
  /** IANA id, e.g. `Europe/Helsinki`. Stored, and used for every conversion. */
  id: string;
  /** The city and country a person would look for. */
  label: string;
}

export interface TimeZoneGroup {
  /** Heading the picker groups these under. */
  region: string;
  zones: readonly TimeZoneOption[];
}

export const TIME_ZONE_GROUPS: readonly TimeZoneGroup[] = [
  {
    region: 'Nordics & Baltics',
    zones: [
      { id: 'Europe/Helsinki', label: 'Helsinki — Finland' },
      { id: 'Europe/Stockholm', label: 'Stockholm — Sweden' },
      { id: 'Europe/Oslo', label: 'Oslo — Norway' },
      { id: 'Europe/Copenhagen', label: 'Copenhagen — Denmark' },
      { id: 'Atlantic/Reykjavik', label: 'Reykjavík — Iceland' },
      { id: 'Europe/Tallinn', label: 'Tallinn — Estonia' },
      { id: 'Europe/Riga', label: 'Riga — Latvia' },
      { id: 'Europe/Vilnius', label: 'Vilnius — Lithuania' },
    ],
  },
  {
    region: 'Europe',
    zones: [
      { id: 'Europe/Dublin', label: 'Dublin — Ireland' },
      { id: 'Europe/Lisbon', label: 'Lisbon — Portugal' },
      { id: 'Europe/London', label: 'London — United Kingdom' },
      { id: 'Europe/Amsterdam', label: 'Amsterdam — Netherlands' },
      { id: 'Europe/Berlin', label: 'Berlin — Germany' },
      { id: 'Europe/Brussels', label: 'Brussels — Belgium' },
      { id: 'Europe/Budapest', label: 'Budapest — Hungary' },
      { id: 'Europe/Madrid', label: 'Madrid — Spain' },
      { id: 'Europe/Paris', label: 'Paris — France' },
      { id: 'Europe/Prague', label: 'Prague — Czechia' },
      { id: 'Europe/Rome', label: 'Rome — Italy' },
      { id: 'Europe/Vienna', label: 'Vienna — Austria' },
      { id: 'Europe/Warsaw', label: 'Warsaw — Poland' },
      { id: 'Europe/Zurich', label: 'Zürich — Switzerland' },
      { id: 'Europe/Athens', label: 'Athens — Greece' },
      { id: 'Europe/Bucharest', label: 'Bucharest — Romania' },
      { id: 'Europe/Kyiv', label: 'Kyiv — Ukraine' },
      { id: 'Europe/Sofia', label: 'Sofia — Bulgaria' },
      { id: 'Europe/Istanbul', label: 'Istanbul — Türkiye' },
      { id: 'Europe/Moscow', label: 'Moscow — Russia' },
      { id: 'UTC', label: 'UTC — no local time' },
    ],
  },
  {
    region: 'Americas',
    zones: [
      { id: 'America/Anchorage', label: 'Anchorage — Alaska' },
      { id: 'America/Los_Angeles', label: 'Los Angeles — US Pacific' },
      { id: 'America/Denver', label: 'Denver — US Mountain' },
      { id: 'America/Chicago', label: 'Chicago — US Central' },
      { id: 'America/New_York', label: 'New York — US Eastern' },
      { id: 'America/Toronto', label: 'Toronto — Canada' },
      { id: 'America/Vancouver', label: 'Vancouver — Canada' },
      { id: 'America/Mexico_City', label: 'Mexico City — Mexico' },
      { id: 'America/Bogota', label: 'Bogotá — Colombia' },
      { id: 'America/Sao_Paulo', label: 'São Paulo — Brazil' },
      { id: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires — Argentina' },
      { id: 'America/Santiago', label: 'Santiago — Chile' },
    ],
  },
  {
    region: 'Africa & Middle East',
    zones: [
      { id: 'Africa/Casablanca', label: 'Casablanca — Morocco' },
      { id: 'Africa/Lagos', label: 'Lagos — Nigeria' },
      { id: 'Africa/Cairo', label: 'Cairo — Egypt' },
      { id: 'Africa/Johannesburg', label: 'Johannesburg — South Africa' },
      { id: 'Africa/Nairobi', label: 'Nairobi — Kenya' },
      { id: 'Asia/Jerusalem', label: 'Jerusalem — Israel' },
      { id: 'Asia/Dubai', label: 'Dubai — United Arab Emirates' },
      { id: 'Asia/Riyadh', label: 'Riyadh — Saudi Arabia' },
    ],
  },
  {
    region: 'Asia & Pacific',
    zones: [
      { id: 'Asia/Karachi', label: 'Karachi — Pakistan' },
      { id: 'Asia/Kolkata', label: 'Kolkata — India' },
      { id: 'Asia/Dhaka', label: 'Dhaka — Bangladesh' },
      { id: 'Asia/Bangkok', label: 'Bangkok — Thailand' },
      { id: 'Asia/Jakarta', label: 'Jakarta — Indonesia' },
      { id: 'Asia/Singapore', label: 'Singapore' },
      { id: 'Asia/Hong_Kong', label: 'Hong Kong' },
      { id: 'Asia/Shanghai', label: 'Shanghai — China' },
      { id: 'Asia/Seoul', label: 'Seoul — South Korea' },
      { id: 'Asia/Tokyo', label: 'Tokyo — Japan' },
      { id: 'Australia/Perth', label: 'Perth — Australia' },
      { id: 'Australia/Brisbane', label: 'Brisbane — Australia' },
      { id: 'Australia/Sydney', label: 'Sydney — Australia' },
      { id: 'Pacific/Auckland', label: 'Auckland — New Zealand' },
    ],
  },
];

export const TIME_ZONE_IDS: readonly string[] = TIME_ZONE_GROUPS.flatMap((group) =>
  group.zones.map((zone) => zone.id),
);

const OFFERED = new Set(TIME_ZONE_IDS);

/**
 * Whether a zone is one this app offered.
 *
 * Exact, not trimmed or case-folded: what arrives here comes from a `<select>`
 * whose values are these ids, so anything that needs cleaning up first did not
 * come from the picker, and quietly repairing it would hide the fact that
 * something is submitting timezones by hand.
 */
export function isOfferedTimeZone(id: unknown): id is string {
  return typeof id === 'string' && OFFERED.has(id);
}

/** The label to show for a stored zone, falling back to its id. */
export function timeZoneLabel(id: string): string {
  for (const group of TIME_ZONE_GROUPS) {
    for (const zone of group.zones) {
      if (zone.id === id) return zone.label;
    }
  }
  return id;
}
