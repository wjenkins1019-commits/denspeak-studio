// Contrast guard on the theme tokens: every colour the app paints is chosen in
// styles.css, so a tweak there is checked here instead of being found later in a
// screenshot. WCAG AA for normal text is 4.5:1, and that is the bar each pair
// below holds to — body and quiet labels, accent text, the focus ring, and the
// text on accent-filled surfaces (the primary button's gradient at both ends,
// and the rail's count badge, which is filled with --accent).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const SRC = fileURLToPath(new URL('.', import.meta.url));

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
function literals(source: string): Literal[] {
  // Comments carry prose about colours, so they are stripped before the scan.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Literal[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of text.matchAll(rule)) {
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
    const painted = literals(css).map(
      (literal) => `${literal.selector} { ${literal.property}: ${literal.value} }`,
    );
    expect(painted).toEqual([]);
  });
});

/** A hex, rgb() or hsl() anywhere in a component, however it is spelled. */
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi;

/** A colour may be a token, or a keyword that borrows the context it is in. */
const THEMED_VALUE =
  /^(var\(--[a-z0-9-]+\)|transparent|currentColor|none|inherit|unset|undefined|url\(#|(?:linear|radial|conic)-gradient\()/i;

const COLOUR_ATTR = /\b(fill|stroke|stopColor|floodColor|color|caretColor)=(["'])([^"']*)\2/g;
const COLOUR_PROP =
  /\b(color|backgroundColor|background|borderColor|outlineColor|textDecorationColor|fill|stroke|stopColor|floodColor|caretColor)\s*:\s*(['"])([^'"]*)\2/g;

/** Every source module under `dir`: components and plain modules alike. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

/**
 * Comments are prose, so they are blanked out before a component is scanned —
 * but their newlines are kept, so a reported line still points at the code.
 * `//` is left alone after a colon, which is how `https://` survives.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (comment, lead: string) => lead + ' '.repeat(comment.length - lead.length));
}

/** Raw colours a component hands to an element, as `label:line  fragment`. */
function inlineColours(label: string, source: string): string[] {
  const text = withoutComments(source);
  const offences: string[] = [];
  const note = (index: number, fragment: string) => {
    const line = text.slice(0, index).split('\n').length;
    offences.push(`${label}:${line}  ${fragment.trim()}`);
  };

  for (const match of text.matchAll(RAW_COLOUR)) note(match.index ?? 0, match[0]);

  for (const pattern of [COLOUR_ATTR, COLOUR_PROP]) {
    for (const match of text.matchAll(pattern)) {
      if (THEMED_VALUE.test(match[3].trim())) continue;
      note(match.index ?? 0, match[0]);
    }
  }

  return offences;
}

/**
 * The styles.css half of the guard cannot see a colour passed straight to an
 * element or kept in a module constant, and either one is just as far outside
 * the token pairs above. Sources paint through tokens too: a raw colour fails.
 */
describe('colours written inline in components and modules', () => {
  it('paints only through tokens', () => {
    const offences = sourceFiles(SRC).flatMap((file) =>
      inlineColours(relative(SRC, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')),
    );

    expect(offences).toEqual([]);
  });
});

describe('what the scans read', () => {
  it('skips a colour mentioned in a stylesheet comment', () => {
    const source = [
      ':root {',
      '  --bg: #040b18;',
      '}',
      '/* the ring used to be #ffffff, which read fine on paper */',
      '.ring {',
      '  /* color: #ff0000; */',
      '  color: var(--text);',
      '}',
    ].join('\n');

    expect(literals(source)).toEqual([]);
  });

  it('still finds a colour a stylesheet rule paints with', () => {
    expect(literals('.card {\n  color: #ff0000;\n}')).toEqual([
      { selector: '.card', property: 'color', value: '#ff0000' },
    ]);
  });

  it('skips a colour mentioned in a component comment', () => {
    const source = [
      'export function Mark() {',
      '  // the tile used to be #0e2a4d',
      '  /* and the sheen came from fill="#5aa8ff" */',
      '  return <rect fill="var(--accent)" />;',
      '}',
    ].join('\n');

    expect(inlineColours('Mark.tsx', source)).toEqual([]);
  });

  it('finds a colour a component hands to an element, and where it is', () => {
    const source = [
      'export function Card() {',
      '  return (',
      "    <span style={{ color: 'red', background: '#ff0000' }} />",
      '  );',
      '}',
    ].join('\n');

    expect(inlineColours('Card.tsx', source)).toEqual([
      'Card.tsx:3  #ff0000',
      "Card.tsx:3  color: 'red'",
      "Card.tsx:3  background: '#ff0000'",
    ]);
  });

  it('finds a colour a plain module keeps as a constant', () => {
    const source = [
      "export const RAIL_TINT = '#5aa8ff';",
      "export const fallback = { accent: '#0b7396' };",
    ].join('\n');

    expect(inlineColours('theme.ts', source)).toEqual(['theme.ts:1  #5aa8ff', 'theme.ts:2  #0b7396']);
  });

  it('does not read a URL as the start of a comment', () => {
    const source = "const url = 'https://example.test/a'; const tint = { color: 'red' };";

    expect(inlineColours('Link.tsx', source)).toEqual(["Link.tsx:1  color: 'red'"]);
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
