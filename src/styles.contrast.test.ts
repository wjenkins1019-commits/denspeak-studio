// Contrast guard on the theme tokens: every colour the app paints is chosen in
// styles.css, so a tweak there is checked here instead of being found later in a
// screenshot. WCAG AA for normal text is 4.5:1, and that is the bar each pair
// below holds to — body and quiet labels, accent text, the focus ring, and the
// text on accent-filled surfaces (the primary button's gradient at both ends,
// and the rail's count badge, which is filled with --accent).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

type Rgb = [number, number, number];
type Colour = { rgb: Rgb; alpha: number };

function tokenBlock(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`styles.css has no "${selector}" block`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) throw new Error(`"${selector}" block is not closed`);
  return css.slice(open + 1, close);
}

function colour(value: string): Colour {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1];
    return {
      rgb: [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb,
      alpha: 1,
    };
  }

  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number(part.trim()));
    return {
      rgb: parts.slice(0, 3) as Rgb,
      alpha: parts.length > 3 ? parts[3] : 1,
    };
  }

  throw new Error(`cannot read colour: ${value}`);
}

function token(block: string, name: string): Colour {
  const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`missing ${name}`);
  return colour(match[1].trim());
}

/** `fg` laid over `bg`, so a translucent surface is measured as it is painted. */
function over(fg: Colour, bg: Colour): Colour {
  return {
    rgb: fg.rgb.map((value, i) => Math.round(fg.alpha * value + (1 - fg.alpha) * bg.rgb[i])) as Rgb,
    alpha: 1,
  };
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Colour, bg: Colour): number {
  const [light, dark] = [luminance(over(fg, bg).rgb), luminance(bg.rgb)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Text pairs the app actually paints: the page, the panel, and the hint box. */
const TEXT_PAIRS: Array<[string, string]> = [
  ['--text', '--bg'],
  ['--text', '--bg-2'],
  ['--muted', '--bg'],
  ['--muted', '--bg-2'],
  ['--dim', '--bg'],
  ['--dim', '--bg-2'],
  ['--dim', '--hint'],
  ['--accent-2', '--bg'],
  ['--accent-2', '--bg-2'],
  ['--danger', '--bg'],
  ['--danger', '--bg-2'],
  ['--warm', '--bg'],
  ['--warm', '--bg-2'],
  // The EQ graph's readout label sits on its own chip.
  ['--text', '--readout'],
];

const THEMES = [
  { theme: 'dark', selector: ':root {' },
  { theme: 'light', selector: ":root[data-theme='light'] {" },
];

type Literal = { selector: string; property: string; value: string };

/** Every rule that paints text, or the surface under it, with a raw colour. */
function literals(): Literal[] {
  // Comments carry prose about colours, so they are stripped before the scan.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Literal[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of source.matchAll(rule)) {
    const selector = match[1].replace(/\s+/g, ' ').trim();
    for (const declaration of match[2].split(';')) {
      const at = declaration.indexOf(':');
      if (at === -1) continue;
      const property = declaration.slice(0, at).trim().toLowerCase();
      if (property !== 'color' && property !== 'fill' && property !== '-webkit-text-fill-color') continue;
      const value = declaration.slice(at + 1).trim();
      // A token, or a keyword that borrows the surrounding colour: not a literal.
      if (/^(var\(|currentColor|inherit|transparent|none|unset)/i.test(value)) continue;
      found.push({ selector, property, value });
    }
  }

  return found;
}

describe('text painted with a raw colour', () => {
  it('uses tokens for every text colour and surface', () => {
    // No exceptions: a colour chosen in a rule rather than a token skips every
    // pair above, so it fails here instead of reaching a screen unchecked.
    const painted = literals().map((literal) => `${literal.selector} { ${literal.property}: ${literal.value} }`);
    expect(painted).toEqual([]);
  });
});

describe.each(THEMES)('$theme theme', ({ selector }) => {
  const block = tokenBlock(selector);
  const surfaces: Record<string, Colour> = {
    '--bg': token(block, '--bg'),
    '--bg-2': token(block, '--bg-2'),
    // The hint box sits on a card, so its translucent fill is measured there.
    '--hint': over(token(block, '--hint-bg'), token(block, '--bg-2')),
    // The readout chip sits on the graph canvas, so its fill is measured there.
    '--readout': over(token(block, '--readout'), token(block, '--bg')),
  };

  it.each(TEXT_PAIRS)('keeps %s readable on %s', (fgToken, bgToken) => {
    const ratio = contrast(token(block, fgToken), surfaces[bgToken]);
    expect(ratio, `${fgToken} on ${bgToken} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps text readable across the accent fill, both ends of the gradient', () => {
    // The primary button fills with --accent-2 to --accent; the rail's count is
    // --accent alone. The text has to clear AA against every end of that.
    const text = token(block, '--primary-text');
    for (const fill of ['--accent-2', '--accent']) {
      const ratio = contrast(text, token(block, fill));
      expect(ratio, `--primary-text on ${fill} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the focus ring visible on the page and on the panel', () => {
    // A non-text indicator only needs 3:1, but it is drawn in the same teal as
    // the labels, so it should not be the thing that looks faint. On the page it
    // is the rail count's ring; on the panel, the QueuePanel buttons'.
    for (const surface of ['--bg', '--bg-2']) {
      const ratio = contrast(token(block, '--accent-2'), token(block, surface));
      expect(ratio, `--accent-2 on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });
});
