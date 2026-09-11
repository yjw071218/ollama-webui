/**
 * The mark, in one place.
 *
 * It is also drawn in `public/favicon.svg` and `public/icon-maskable.svg`,
 * because a browser tab and a home screen cannot import a React component.
 * `scripts/logo.test.mjs` compares the arcs across all three, since a mark
 * that differs between the tab and the sidebar is not a mark.
 *
 * Two arcs closing on a centre, the outer running most of a turn and the inner
 * about a third. See the favicon for why they are graded rather than
 * concentric, and why the spacing is what it is.
 */
export const Logo = ({ size = 16, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    {/* currentColor, so the mark takes the colour of whatever it sits in. */}
    <g fill="none" stroke="currentColor" strokeLinecap="round">
          <path d="M15 4.54A11.5 11.5 0 1 1 6.58 9.4" strokeWidth={2.6} />
          <path d="M15.44 9.62A6.4 6.4 0 0 1 20.53 20.53" strokeWidth={2.8} />
        </g>
        <circle cx="16" cy="16" r={2.3} fill="currentColor" />
  </svg>
);

/** The mark with its container, for anywhere it needs to stand on its own. */
export const LogoMark = ({ size = 28, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    <rect width="32" height="32" rx="8" fill="var(--primary)" />
    <g fill="none" stroke="#F7F5F0" strokeLinecap="round">
          <path d="M15 4.54A11.5 11.5 0 1 1 6.58 9.4" strokeWidth={2.6} />
          <path d="M15.44 9.62A6.4 6.4 0 0 1 20.53 20.53" strokeWidth={2.8} />
        </g>
        <circle cx="16" cy="16" r={2.3} fill="#F7F5F0" />
  </svg>
);

export default Logo;
