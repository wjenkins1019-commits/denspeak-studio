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

/** Keys that paint: SVG attributes first, then the wider style properties. */
const ATTR_KEYS = ['fill', 'stroke', 'stopColor', 'floodColor', 'color', 'caretColor'];
const STYLE_KEYS = ['backgroundColor', 'background', 'borderColor', 'outlineColor', 'textDecorationColor', ...ATTR_KEYS];
const ATTRIBUTES = ATTR_KEYS.join('|');

const COLOUR_ATTR = new RegExp(`\\b(${ATTRIBUTES})=(["'])([^"']*)\\2`, 'g');
const COLOUR_ATTR_EXPR = new RegExp(`\\b(${ATTRIBUTES})=\\{`, 'g');
const COLOUR_PROP = new RegExp(`\\b(${STYLE_KEYS.join('|')})\\s*:\\s*`, 'g');
const QUOTED = /(['"`])((?:[^'"`\\]|\\.)*)\1/g;

/**
 * The CSS colour keywords. A string in a colour position is only suspect if it
 * names one of these, so `theme === 'light'` choosing between two tokens is
 * left alone while `hot ? 'red' : …` is not.
 */
const NAMED_COLOURS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
  crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
  darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
  dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
  lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
  yellowgreen`
    .split(/\s+/)
    .filter(Boolean),
);

const namesColour = (value: string) => NAMED_COLOURS.has(value.trim().toLowerCase());

/** Any colour name inside a run of text, as words rather than whole values. */
const COLOUR_NAME = new RegExp(`\\b(${[...NAMED_COLOURS].join('|')})\\b`, 'gi');

/** `${…}` is code, not CSS: blank it, keeping its length, before reading. */
const withoutInterpolation = (source: string) =>
  source.replace(/\$\{[^{}]*\}/g, (part) => ' '.repeat(part.length));

/** A CSS property whose value paints: colours, borders, shadows, fills. */
const paintsCss = (property: string) =>
  /^--|(?:^|-)(?:color|background|background-image|border|border-(?:top|right|bottom|left)|outline|box-shadow|text-shadow|fill|stroke)$/.test(
    property.trim().toLowerCase(),
  );

/**
 * Colour names inside a string that reads as CSS. A stylesheet written as a
 * template is text until it is rendered, so the declaration is found and its
 * value read: `background: linear-gradient(red, …)`. A colour function with no
 * property around it — a gradient handed straight to a style prop — counts too.
 */
function cssColours(css: string, base: number): Array<{ index: number; fragment: string }> {
  const found: Array<{ index: number; fragment: string }> = [];
  const source = withoutInterpolation(css);
  const add = (offset: number, fragment: string) => found.push({ index: base + offset, fragment });
  let declarations = 0;

  for (const match of source.matchAll(/([-\w]+)\s*:\s*([^;{}]+)/g)) {
    declarations += 1;
    if (!paintsCss(match[1])) continue;

    const value = match[2];
    const start = (match.index ?? 0) + match[0].length - value.length;
    for (const name of value.matchAll(COLOUR_NAME)) add(start + (name.index ?? 0), `${match[1]}: ${name[0]}`);
  }

  if (declarations === 0 && /-gradient\(|\brgba?\(|\bhsla?\(/i.test(source)) {
    for (const name of source.matchAll(COLOUR_NAME)) add(name.index ?? 0, `'${name[0]}' in a colour function`);
  }

  return found;
}

/**
 * The value of a property, cut where the property ends rather than at the next
 * quote. Brackets and strings are counted so a comma inside a call does not end
 * it early — a depth counter, not a parser.
 *
 * A newline at depth 0 also ends it. That keeps a value from running into the
 * rest of the file (a CSS snippet built in a string, say) at the cost of not
 * reading an expression broken onto a second line after its first token; every
 * colour position in the app is written on one line.
 */
function valueAt(text: string, from: number): { value: string; at: number } {
  // Leading whitespace belongs to the layout, not the value: an attribute
  // written `fill={` over several lines still starts at its expression.
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const at = i;

  let depth = 0;
  let quote: string | null = null;

  while (i < text.length) {
    const char = text[i];

    if (quote) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      i += 1;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      i += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
      continue;
    }

    if ((char === ',' || char === '\n') && depth === 0) break;
    i += 1;
  }

  return { value: text.slice(at, i).trim(), at };
}

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
 *
 * Strings are followed rather than regex-matched, so a `//` in `'a//b'` or in a
 * template literal is text, not a comment, and an escaped quote does not end the
 * string early. `${…}` re-enters code so a comment inside an interpolation is
 * still stripped. Regex literals are not tracked: a `/…/` containing `//` would
 * be read as a comment, which no source under src does today.
 */
function withoutComments(source: string): string {
  type Frame = { kind: 'code'; braces: number } | { kind: 'template' };
  const stack: Frame[] = [{ kind: 'code', braces: 0 }];
  let quote: "'" | '"' | null = null;
  let out = '';
  let i = 0;

  while (i < source.length) {
    const frame = stack[stack.length - 1];
    const char = source[i];
    const next = source[i + 1];

    if (frame.kind === 'template') {
      if (char === '\\') {
        out += char + (next ?? '');
        i += 2;
      } else if (char === '`') {
        stack.pop();
        out += char;
        i += 1;
      } else if (char === '$' && next === '{') {
        stack.push({ kind: 'code', braces: 0 });
        out += '${';
        i += 2;
      } else {
        out += char;
        i += 1;
      }
      continue;
    }

    if (quote) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 2;
      } else {
        if (char === quote) quote = null;
        i += 1;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      i += 1;
      continue;
    }

    if (char === '`') {
      stack.push({ kind: 'template' });
      out += char;
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (char === '{') {
      frame.braces += 1;
    } else if (char === '}') {
      // A brace that closes an interpolation hands the scan back to the string.
      if (frame.braces > 0) frame.braces -= 1;
      else if (stack.length > 1) stack.pop();
    }

    out += char;
    i += 1;
  }

  return out;
}

/** Raw colours a component hands to an element, as `label:line  fragment`. */
function inlineColours(label: string, source: string): string[] {
  const text = withoutComments(source);
  const offences: Array<{ index: number; fragment: string }> = [];
  const reported = new Set<number>();
  const note = (index: number, fragment: string) => {
    reported.add(index);
    offences.push({ index, fragment: fragment.trim() });
  };

  /** A colour named inside an expression: `hot ? 'red' : undefined`. */
  const flagNames = (value: string, at: number, property: string) => {
    for (const inner of value.matchAll(QUOTED)) {
      if (!namesColour(inner[2])) continue;
      note(at + (inner.index ?? 0), `${property}: ${inner[0]}`);
    }
  };

  for (const match of text.matchAll(RAW_COLOUR)) note(match.index ?? 0, match[0]);

  for (const match of text.matchAll(COLOUR_ATTR)) {
    if (THEMED_VALUE.test(match[3].trim())) continue;
    note(match.index ?? 0, match[0]);
  }

  // An attribute handed an expression instead of a string.
  for (const match of text.matchAll(COLOUR_ATTR_EXPR)) {
    const { value, at } = valueAt(text, (match.index ?? 0) + match[0].length);
    flagNames(value, at, match[1]);
  }

  for (const match of text.matchAll(COLOUR_PROP)) {
    const { value, at } = valueAt(text, (match.index ?? 0) + match[0].length);
    const single = value.match(/^(['"])((?:[^'"\\]|\\.)*)\1$/);

    // A plain string is checked whole; anything else is an expression whose
    // strings only matter if one of them names a colour.
    if (single) {
      if (!THEMED_VALUE.test(single[2].trim())) note(at, `${match[1]}: ${single[0]}`);
    } else {
      flagNames(value, at, match[1]);
    }
  }

  // A bare name is a colour too: `export const TINT = 'white'` has no property
  // or attribute to bring it in, so any string that is nothing but a colour
  // name is reported. Already-reported strings are skipped, keeping each one
  // against the property that gave it context.
  for (const match of text.matchAll(QUOTED)) {
    const index = match.index ?? 0;
    if (reported.has(index) || !namesColour(match[2])) continue;
    note(index, match[0]);
  }

  // A stylesheet built in a string keeps its colours as text until it renders,
  // so its declarations are read here rather than as a component's own paint.
  for (const match of text.matchAll(QUOTED)) {
    for (const colour of cssColours(match[2], (match.index ?? 0) + 1)) note(colour.index, colour.fragment);
  }

  // The checks run property by property, so their findings are sorted back into
  // source order: a failure then reads down the file instead of jumping around.
  return offences
    .sort((a, b) => a.index - b.index)
    .map(({ index, fragment }) => {
      const line = text.slice(0, index).split('\n').length;
      return `${label}:${line}  ${fragment}`;
    });
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
      "Card.tsx:3  color: 'red'",
      "Card.tsx:3  background: '#ff0000'",
      'Card.tsx:3  #ff0000',
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

  it('does not read a // inside a string as the start of a comment', () => {
    expect(inlineColours('Path.tsx', "const p = 'a//b'; const tint = { color: 'red' };")).toEqual([
      "Path.tsx:1  color: 'red'",
    ]);
    expect(inlineColours('Path.tsx', 'const p = "x // y"; const tint = { fill: \'red\' };')).toEqual([
      "Path.tsx:1  fill: 'red'",
    ]);
    // An escaped quote does not end the string early, so the // after it is text.
    expect(inlineColours('Path.tsx', "const p = 'it\\'s // fine'; const tint = { fill: 'red' };")).toEqual([
      "Path.tsx:1  fill: 'red'",
    ]);
  });

  it('checks the strings inside a conditional colour', () => {
    expect(
      inlineColours('Meter.tsx', "const s = { background: hot ? 'var(--danger)' : undefined };"),
    ).toEqual([]);
    expect(
      inlineColours('Meter.tsx', "const s = { background: hot ? 'red' : 'var(--danger)' };"),
    ).toEqual(["Meter.tsx:1  background: 'red'"]);
    // The same expression handed to an attribute.
    expect(inlineColours('Meter.tsx', "<rect fill={hot ? 'white' : 'var(--line)'} />")).toEqual([
      "Meter.tsx:1  fill: 'white'",
    ]);
  });

  it('finds a colour named in a stylesheet built in a string', () => {
    const source = [
      'const sheet = `',
      '  background: linear-gradient(red, ${stop});',
      '  color: white;',
      '`;',
    ].join('\n');

    expect(inlineColours('Sheet.tsx', source)).toEqual([
      'Sheet.tsx:2  background: red',
      'Sheet.tsx:3  color: white',
    ]);
  });

  it('finds a colour named in a gradient handed to a style', () => {
    const source = 'const s = { background: `linear-gradient(${a}, red)` };';

    expect(inlineColours('Sheet.tsx', source)).toEqual(["Sheet.tsx:1  'red' in a colour function"]);
  });

  it('leaves a property that does not paint alone', () => {
    expect(inlineColours('Sheet.tsx', "const sheet = 'font-family: Red Hat Display;';")).toEqual([]);
  });

  it('reads an attribute expression that spans several lines', () => {
    const source = [
      '<svg',
      '  fill={',
      "    hot ? 'red' : 'var(--line)'",
      '  }',
      '/>',
    ].join('\n');

    expect(inlineColours('Mark.tsx', source)).toEqual(["Mark.tsx:3  fill: 'red'"]);
  });

  it('leaves a comparison alone when it picks between tokens', () => {
    const source = "const s = { color: theme === 'light' ? 'var(--text)' : 'var(--text-2)' };";

    expect(inlineColours('Tint.tsx', source)).toEqual([]);
  });

  it('finds a colour a component hands to an attribute', () => {
    expect(inlineColours('Mark.tsx', '<rect fill="#0a0b0c" />')).toEqual([
      'Mark.tsx:1  fill="#0a0b0c"',
      'Mark.tsx:1  #0a0b0c',
    ]);
  });

  it('finds a bare colour name in a plain module', () => {
    const source = [
      "export const TINT = 'white';",
      "export const FLAT = 'tomato';",
      "export const LABEL = 'white noise';",
      "export const MODE = 'light';",
    ].join('\n');

    expect(inlineColours('theme.ts', source)).toEqual(["theme.ts:1  'white'", "theme.ts:2  'tomato'"]);
  });

  it('checks a colour handed through a call', () => {
    const source = ['const s = {', "  borderColor: pick(level, 'red', 'var(--line)'),", '};'].join('\n');

    expect(inlineColours('Tint.tsx', source)).toEqual(["Tint.tsx:2  borderColor: 'red'"]);
  });

  it('does not read a // inside a template literal as the start of a comment', () => {
    const source = [
      'const fill = `/// ${1} #fff`;',
      "const tint = { color: 'red' };",
    ].join('\n');

    // The template is still scanned — a colour written into one is a colour —
    // but the slashes in it are not a comment and the next line is not eaten.
    expect(inlineColours('Tint.tsx', source)).toEqual(['Tint.tsx:1  #fff', "Tint.tsx:2  color: 'red'"]);
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
