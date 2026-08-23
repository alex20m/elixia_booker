/**
 * The app's mark, drawn rather than loaded.
 *
 * Inline SVG so it inherits the theme: the two colours are read from custom
 * properties, which means the logo follows a palette change with everything
 * else instead of being a picture that has to be re-exported. The fallbacks
 * after each `var()` matter — this same markup is rasterised into the PNG app
 * icons, where no stylesheet exists.
 *
 * `EB` is built from bars and arcs on one grid rather than set in a typeface on
 * purpose. A logo that depends on a webfont renders in whatever the fallback is
 * when the font is still loading, in an email client, or in a standalone
 * `icon.svg` the browser fetches with no page around it — three places this
 * mark has to survive.
 *
 * The construction, which every number below comes from:
 *
 * - Both letters sit on one 11° oblique, applied to the pair rather than to
 *   each letter, so they share a single italic axis. Elixia's own E is a heavy
 *   oblique with square-cut terminals; the skew is what makes this that letter
 *   and not a different one.
 * - Stroke 8.0 and gap 2.6 on a 29.2 cap height. The B is drawn at 7.6 — a hair
 *   lighter, because a round letter beside a square one reads heavier at equal
 *   measure — and the space between the two letters is the same 2.6 as the gaps
 *   inside the E, so neither looks bolted onto the other.
 * - The B's bowls are half-rounds of radius 8.8 and 9.6, the lower one larger,
 *   with counters of 2.4 and 4.0. The upper counter is deliberately the same
 *   height as the E's gaps: whatever size closes one closes the other, so the
 *   two letters degrade together instead of the B turning to mush first.
 *
 * `app/icon.svg` carries this same geometry with the colours resolved, for the
 * places a browser fetches an icon on its own, and `tests/brand.test.tsx`
 * checks the two against each other — a mark that exists twice is a mark that
 * drifts.
 */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="48" height="48" rx="12" fill="var(--brand-tile, #0d2134)" />
      <g transform="translate(-7.8 0) translate(24 24) scale(0.7) skewX(-11) translate(-24 -24)">
        <g fill="var(--brand-ink, #ffffff)">
          <rect x="10.6" y="9.4" width="8.7" height="29.2" />
          <rect x="10.6" y="9.4" width="27" height="8" />
          <rect x="10.6" y="20" width="21" height="8" />
          <rect x="10.6" y="30.6" width="27" height="8" />
        </g>
        <g fill="var(--brand-accent, #fa5333)" transform="translate(40.2 9.4)">
          <rect x="0" y="0" width="7.6" height="29.2" />
          <rect x="0" y="0" width="12.7" height="7.6" />
          <rect x="0" y="10" width="12.7" height="7.6" />
          <rect x="0" y="21.6" width="12.7" height="7.6" />
          <path d="M12.4 0A8.8 8.8 0 0 1 12.4 17.6L12.4 10A1.2 1.2 0 0 0 12.4 7.6Z" />
          <path d="M12.4 10A9.6 9.6 0 0 1 12.4 29.2L12.4 21.6A2 2 0 0 0 12.4 17.6Z" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Mark plus name, which is the logo proper — the mark alone is only ever the
 * app icon. `Booker` is set apart from `Elixia` because this is not Elixia's
 * app: the gym's name says what it books, and the second word says what it is.
 *
 * The name is set in caps and tracked out by the stylesheet. Inter is the
 * interface's own face, so register is the only thing separating the logotype
 * from a stray heading; sentence case at 16px gave it none.
 */
export function Brand({ size = 30, large = false }: { size?: number; large?: boolean }) {
  return (
    <span className={large ? 'brand brand-lg' : 'brand'}>
      <LogoMark size={large ? 40 : size} className="brand-mark" />
      <span className="brand-name">
        Elixia <span className="brand-name-accent">Booker</span>
      </span>
    </span>
  );
}
