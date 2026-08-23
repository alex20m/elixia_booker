import { Shell } from './Shell';

/**
 * The three shapes a wait is allowed to take in this app.
 *
 * They exist as one file because the alternative — each screen inventing its
 * own — is what the app had, and it produced three different answers to the
 * same question. A dashboard that said "Loading your account…" in centred grey
 * text, a class picker that said it inside a disabled dropdown, and a handful
 * of buttons that said nothing at all and simply did not respond for a second.
 * The third is the one that actually hurt: a Remove button with no busy state
 * is a button people press twice, and the second press is a second DELETE.
 *
 * Which shape to reach for is decided by what is already on screen:
 *
 *   * **Nothing yet** — a screen being loaded for the first time — gets
 *     `LoadingScreen`: skeletons in the shape of what is coming, so the layout
 *     does not jump, plus one sentence naming the wait.
 *   * **A control was pressed** gets a spinner inside that control. That is
 *     `ActionButton`, which is next door because it also owns the part a
 *     spinner alone does not fix: refusing the second press.
 *   * **Content is already on screen and is being refreshed** gets `BusyBar`.
 *     Swapping a filled dashboard back to skeletons on every save reads as the
 *     page having lost its data; a line under the app bar says newer data is
 *     coming without taking the old away.
 *
 * Skeletons are hidden from assistive technology — a screen reader has no use
 * for the shape of what has not arrived — so each screen carries exactly one
 * live region saying, in words, what is being waited for.
 */

/** Widths that make a block of skeleton lines read as prose rather than a bar chart. */
const LINE_WIDTHS = ['100%', '80%', '90%', '65%'];

/**
 * The spinning mark, plus an optional label for screen readers.
 *
 * The label is optional because most spinners here sit inside something that
 * already says what it is doing — a button whose text has changed to
 * "Saving…", a paragraph explaining the wait. A second announcement of the
 * same fact is noise.
 */
export function Spinner({ label }: { label?: string }) {
  return (
    <>
      <span className="spinner" aria-hidden="true" />
      {label !== undefined && <span className="sr-only">{label}</span>}
    </>
  );
}

/** One placeholder line. */
export function SkeletonLine({ width }: { width?: string }) {
  return <span className="skeleton skeleton-line" style={width ? { width } : undefined} />;
}

/**
 * A card-shaped placeholder: a title bar and some lines under it.
 *
 * Sized in lines rather than pixels so a caller can say roughly how big the
 * real card is, and the page it stands in does not resize when the content
 * lands.
 */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <section className="card" aria-hidden="true">
      <div className="card-head">
        <span className="skeleton skeleton-title" />
      </div>
      <div className="skeleton-lines">
        {Array.from({ length: lines }, (_, index) => (
          <SkeletonLine key={index} width={LINE_WIDTHS[index % LINE_WIDTHS.length]} />
        ))}
      </div>
    </section>
  );
}

/** A card-shaped placeholder for a list, laid out as rows rather than prose. */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <section className="card" aria-hidden="true">
      <div className="card-head">
        <span className="skeleton skeleton-title" />
      </div>
      <div>
        {Array.from({ length: rows }, (_, index) => (
          <div className="skeleton-row" key={index}>
            <SkeletonLine width="55%" />
            <SkeletonLine width="35%" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The one thing on a loading screen that is not decoration: a sentence saying
 * which wait this is.
 *
 * `role="status"` rather than an alert, because a load in progress is not an
 * interruption — it is announced when the reader next has a gap.
 */
export function LoadingStatus({ label }: { label: string }) {
  return (
    <p className="loading-status" role="status" aria-live="polite">
      <Spinner />
      <span>{label}</span>
    </p>
  );
}

/**
 * A whole screen that has not arrived yet: the app's own frame, a sentence, and
 * skeletons shaped like the page underneath.
 *
 * The frame is part of it on purpose. A bare spinner on an empty page is
 * indistinguishable from a page that failed to load its stylesheet, and it
 * throws the app bar away only to put it back a moment later.
 */
export function LoadingScreen({
  label,
  narrow = false,
  actions,
  children,
}: {
  label: string;
  /** The one-decision column the wizard and the sign-in panel use. */
  narrow?: boolean;
  /** Whatever the loaded screen puts in the app bar, so the bar does not change. */
  actions?: React.ReactNode;
  /** The skeletons to show. Two generic cards when a caller has nothing better. */
  children?: React.ReactNode;
}) {
  return (
    <Shell actions={actions}>
      <main className={narrow ? 'main main-narrow' : 'main'}>
        <LoadingStatus label={label} />
        {children ?? (
          <>
            <SkeletonCard lines={3} />
            <SkeletonCard lines={2} />
          </>
        )}
      </main>
    </Shell>
  );
}

/**
 * A refresh of content that is already on screen.
 *
 * Mounted whether or not anything is happening, so that the live region beside
 * it is a region that changed rather than an element that appeared — screen
 * readers announce the former reliably and the latter only sometimes.
 */
export function BusyBar({ busy, label }: { busy: boolean; label: string }) {
  return (
    <>
      <div className={busy ? 'busybar is-busy' : 'busybar'} aria-hidden="true">
        <span className="busybar-fill" />
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {busy ? label : ''}
      </span>
    </>
  );
}
