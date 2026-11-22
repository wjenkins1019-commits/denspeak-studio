import { useId } from 'react';

/**
 * The Denspeak Studio mark: a speech bubble with a waveform cut out of it.
 * Same shapes as assets/icon.svg, with per-instance gradient ids so the rail
 * and the About card can both be on screen without colliding. Its colours come
 * from the `.logo-mark` palette in styles.css — brand art, the same in both
 * themes — so no component carries a raw colour.
 */
export function LogoMark({ size = 42 }: { size?: number }) {
  const id = useId().replace(/[:]/g, '');

  return (
    <svg
      className="logo-mark"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role="img"
      aria-label="Denspeak Studio"
    >
      <defs>
        <linearGradient id={`${id}-tile`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="var(--logo-tile-top)" />
          <stop offset="0.55" stopColor="var(--logo-tile-mid)" />
          <stop offset="1" stopColor="var(--logo-deep)" />
        </linearGradient>
        <radialGradient id={`${id}-sheen`} cx="0.5" cy="0.05" r="0.85">
          <stop offset="0" stopColor="var(--logo-sheen)" stopOpacity="0.42" />
          <stop offset="0.55" stopColor="var(--logo-sheen)" stopOpacity="0.08" />
          <stop offset="1" stopColor="var(--logo-sheen)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-ink`} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="var(--logo-ink-top)" />
          <stop offset="0.5" stopColor="var(--logo-ink-mid)" />
          <stop offset="1" stopColor="var(--logo-ink-bottom)" />
        </linearGradient>
        <linearGradient id={`${id}-slot`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--logo-slot-top)" />
          <stop offset="1" stopColor="var(--logo-deep)" />
        </linearGradient>
      </defs>

      <rect width="512" height="512" rx="116" fill={`url(#${id}-tile)`} />
      <rect width="512" height="512" rx="116" fill={`url(#${id}-sheen)`} />
      <rect x="112" y="132" width="288" height="196" rx="86" fill={`url(#${id}-ink)`} />
      <path d="M166 296 L146 376 L232 326 Z" fill={`url(#${id}-ink)`} />
      <g fill={`url(#${id}-slot)`}>
        <rect x="169" y="207" width="24" height="46" rx="12" />
        <rect x="219" y="184" width="24" height="92" rx="12" />
        <rect x="269" y="166" width="24" height="128" rx="12" />
        <rect x="319" y="194" width="24" height="72" rx="12" />
      </g>
    </svg>
  );
}
