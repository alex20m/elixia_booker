/**
 * The membership tiers a booking window can come from.
 *
 * There is no default here on purpose. How far ahead someone may book is a
 * property of the contract they signed with Elixia, and this app cannot see it
 * — so guessing 7 means a Premium member silently books a week late for as long
 * as it takes them to notice, and guessing 14 means a Basic member's every
 * attempt fires a week early and fails. Both failures look like the app being
 * broken rather than like a setting being wrong, which is why the choice is
 * asked for before anything can be booked at all.
 */

export interface MembershipOption {
  /** Days ahead of a class that booking opens. */
  days: number;
  /** What the tier is called on Elixia's own price list, and its window. */
  label: string;
}

export const MEMBERSHIP_OPTIONS: readonly MembershipOption[] = [
  { days: 7, label: 'Basic / Flexible — books 7 days ahead' },
  { days: 14, label: 'Premium — books 14 days ahead' },
];

const DAYS = new Set(MEMBERSHIP_OPTIONS.map((option) => option.days));

/**
 * Whether a stored booking window is one of the offered tiers.
 *
 * Applies to the profile only. A single class may still override it with any
 * window the schema allows — that is a deliberate escape hatch for a class
 * Elixia releases on its own terms, and it is set per class, not per account.
 */
export function isMembershipWindow(days: unknown): days is number {
  return typeof days === 'number' && Number.isInteger(days) && DAYS.has(days);
}
