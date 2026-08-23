/**
 * The app's mark, drawn rather than loaded.
 *
 * Inline SVG so it inherits the theme: the two colours are read from custom
 * properties, which means the logo follows a palette change with everything
 * else instead of being a picture that has to be re-exported. The fallbacks
 * after each `var()` matter — this same markup is rasterised into the PNG app
 * icons, where no stylesheet exists.
 *
 * `EB` is built from bars rather than set in a typeface on purpose. A logo that
 * depends on a webfont renders in whatever the fallback is when the font is
 * still loading, in an email client, or in a standalone `icon.svg` the browser
 * fetches with no page around it — three places this mark has to survive.
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
      <rect width="48" height="48" rx="12" fill="var(--brand-tile, #101418)" />
      <g fill="var(--brand-ink, #ffffff)">
        <rect x="8.6" y="13" width="5.8" height="22" rx="2.6" />
        <rect x="8.6" y="13" width="16.6" height="5.8" rx="2.6" />
        <rect x="8.6" y="21.1" width="13.2" height="5.8" rx="2.6" />
        <rect x="8.6" y="29.2" width="16.6" height="5.8" rx="2.6" />
      </g>
      <g fill="var(--brand-accent, #c8ff3d)">
        <rect x="28.4" y="13" width="5.8" height="22" rx="2.6" />
        <path
          fillRule="evenodd"
          d="M31.3 13h3.6a5.35 5.35 0 0 1 0 10.7h-3.6Zm2.9 2.9v4.9h.7a2.45 2.45 0 0 0 0-4.9Z"
        />
        <path
          fillRule="evenodd"
          d="M31.3 24.3h4.6a5.35 5.35 0 0 1 0 10.7h-4.6Zm2.9 2.9v4.9h1.7a2.45 2.45 0 0 0 0-4.9Z"
        />
      </g>
    </svg>
  );
}

/**
 * Mark plus name, which is the logo proper — the mark alone is only ever the
 * app icon. `Booker` is set apart from `Elixia` because this is not Elixia's
 * app: the gym's name says what it books, and the second word says what it is.
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
