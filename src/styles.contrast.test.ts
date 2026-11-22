// Contrast guard on the theme tokens: every colour the app paints is chosen in
// styles.css, so a tweak there is checked here instead of being found later in a
// screenshot. WCAG AA for normal text is 4.5:1, and that is the bar each pair
// below holds to — body and quiet labels, accent text, the focus ring, the text
// on accent-filled surfaces (the primary button's gradient at both ends, and the
// rail's count badge, which is filled with --accent), the text over the
// accent washes the page gradient lays across the top of the window, and the
// graph labels over the glow the EQ graph paints over its background.
//
// Every theme block in the file is measured, and every token has to be named by
// a check or declared as painting no text, so a new theme or colour cannot be
// added without being looked at.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const SRC = fileURLToPath(new URL('.', import.meta.url));

type Rgb = [number, number, number];
type Colour = { rgb: Rgb; alpha: number };

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

function tokenText(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`missing ${name}`);
  return match[1].trim();
}

function token(block: string, name: string): Colour {
  return colour(tokenText(block, name));
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
  // The graph's axis labels sit on its glow, over both ends of its background.
  ['--dim', '--graph'],
  ['--dim', '--graph-soft'],
  // The danger note sits on its own tinted box, not on the page.
  ['--danger-text', '--danger-bg'],
  // Cards, panels and the rail's active item are translucent surfaces with
  // labels on them, measured over the page they are painted on.
  ['--text', '--panel'],
  ['--text', '--panel-strong'],
  ['--text', '--surface'],
  ['--text', '--surface-soft'],
  ['--text', '--active-soft'],
  ['--text', '--active-strong'],
];

/**
 * UI colours that carry no text, where WCAG 1.4.11 asks for 3:1: the accent as
 * a fill, the sliders' accent-coloured track and thumb, the EQ curve's gradient,
 * and the level meter's hot bar.
 */
const UI_PAIRS: Array<[string, string]> = [
  // The accent as a fill: the primary button's deep end and the rail count.
  ['--accent', '--bg-2'],
  // `input[type='range']` takes its colour from the accent and sits on a card.
  ['--accent', '--panel'],
  // The curve is the accent gradient drawn on the graph's own background, which
  // runs from --surface to --surface-soft.
  ['--accent', '--surface'],
  ['--accent', '--surface-soft'],
  ['--accent-2', '--surface'],
  ['--accent-2', '--surface-soft'],
  // The level meter fills with the danger colour when the input is hot.
  ['--danger', '--panel'],
];

/** Ends of the fill the primary button and the rail count are painted with. */
const ACCENT_FILLS = ['--accent-2', '--accent'];

/** Surfaces the focus ring is drawn against. */
const RING_SURFACES = ['--bg', '--bg-2'];

/**
 * Every theme block in a stylesheet, so a third theme is measured too.
 *
 * A theme owns a root selector that stands alone: `:root`, or `:root[data-theme=
 * '…']`. Written in a selector list (`:root, :root[data-theme='x']`) or with
 * something after it, the pattern below would not see it, so the rule count that
 * follows turns that into a failure rather than a theme nothing measures.
 */
function themesIn(source: string) {
  const themes = [...source.matchAll(/^[ \t]*(:root(?:\[[^\]]*\])?)[ \t]*\{/gm)].map((match) => {
    const selector = match[1];
    const open = (match.index ?? 0) + match[0].length - 1;
    const named = selector.match(/data-theme=['"]([a-z0-9_-]+)['"]/);

    return { theme: named ? named[1] : 'default', selector, block: source.slice(open + 1, source.indexOf('}', open)) };
  });

  // Two blocks read as the same theme would be measured twice under one title.
  const names = new Set<string>();
  for (const { theme } of themes) {
    if (names.has(theme)) throw new Error(`two theme blocks read as "${theme}"`);
    names.add(theme);
  }

  // Every rule that declares itself a root block, comments aside, has to be one
  // of the themes read above.
  const roots = [
    ...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].filter(([, selector]) =>
    selector.split(',').some((part) => /^:root(?:\[[^\]]*\])?$/.test(part.trim())),
  );

  if (roots.length !== themes.length) {
    throw new Error(`${roots.length} root blocks in the stylesheet, ${themes.length} read as themes`);
  }

  return themes;
}

const THEMES = themesIn(css);

/** Text tokens the app paints straight on the page rather than on a card. */
const PAGE_TEXT = [...new Set(TEXT_PAIRS.filter(([, bg]) => bg === '--bg' || bg === '--bg-2').map(([fg]) => fg))];

/**
 * Text the rail paints, with whether the active item's tint is under it: the
 * active item swaps its label to --text and its hint to --accent-2, so the
 * quiet --dim and --muted only ever sit on the rail wash itself.
 */
const RAIL_TEXT: Array<[fg: string, onActiveTint: boolean]> = [
  ['--text', true],
  ['--accent-2', true],
  ['--muted', false],
  ['--dim', false],
];

/**
 * The window sizes the page is laid out in, read from the Electron main process
 * rather than assumed: the app opens at one size and can be dragged down to its
 * minimum, and a bigger screen would be bigger again. The frame and title bar
 * come off the smallest, because the page is shorter than the window it sits in.
 */
function windowSizes(): Array<{ width: number; height: number }> {
  const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  const options = main.match(/new BrowserWindow\(\{([\s\S]*?)\n  \}\);/);
  if (!options) throw new Error('cannot read the BrowserWindow options in electron/main.js');

  const option = (name: string) => {
    const match = options[1].match(new RegExp(`\\b${name}:\\s*(\\d+)`));
    if (!match) throw new Error(`BrowserWindow declares no ${name}`);
    return Number(match[1]);
  };

  const opened = { width: option('width'), height: option('height') };
  // Windows puts roughly this much chrome above the page; taking it off can
  // only deepen the wash measured below, so it errs towards the stricter check.
  const smallest = { width: option('minWidth') - 16, height: option('minHeight') - 100 };

  // These two are the whole range, not a sample: the wash's centre moves with
  // the window while its radii stay fixed pixels, so a bigger window is never
  // deeper, and the test below holds that. A third size would measure nothing
  // the smallest does not.
  return [smallest, opened];
}

const WINDOW_SIZES = windowSizes();

/**
 * The colour stops a gradient token declares, in source order. A stop written in
 * a form this reader does not know would leave a layer out of the stack it is
 * measured in, so one it cannot parse is refused rather than skipped.
 */
function gradientStops(block: string, name: string): Colour[] {
  const value = tokenText(block, name);
  const readable = /#[0-9a-f]{6}\b|rgba?\([^)]+\)/gi;
  const stops = [...value.matchAll(readable)].map((match) => colour(match[0]));

  const leftover = value.replace(readable, '');
  if (/#[0-9a-f]|\brgba?\(|\bhsla?\(/i.test(leftover)) {
    throw new Error(`${name} has a colour stop this reader cannot parse: ${value}`);
  }

  return stops;
}

/** A radial wash from --bg-image, with the geometry it fades over. */
type Wash = {
  colour: Colour;
  radius: { x: number; y: number };
  /** As a fraction of the viewport, the way the token writes it. */
  centre: { x: number; y: number };
  /** Where the alpha reaches zero, as a fraction of the ray to the ellipse. */
  fade: number;
};

/**
 * The radial washes --bg-image paints, each read as
 * `<x>px <y>px at <x>% <y>%, <colour>, transparent <n>%`.
 *
 * Percentage stops are measured along the ray from the centre to the ellipse's
 * edge, which is the same normalised distance `washDepth` computes, so a stop
 * means what this reads it as. Any other shape — the stops swapped, a third
 * stop, a hex colour — leaves a wash unread, so the count below refuses it
 * instead of quietly measuring fewer washes than the page paints.
 */
function pageWashes(block: string): Wash[] {
  const value = tokenText(block, '--bg-image');
  const declared = (value.match(/radial-gradient\(/g) ?? []).length;

  const washes = [
    ...value.matchAll(
      /radial-gradient\(\s*([\d.]+)px\s+([\d.]+)px\s+at\s+([\d.]+)%\s+(-?[\d.]+)%\s*,\s*(rgba?\([^)]+\))\s*,\s*transparent\s+([\d.]+)%\s*\)/g,
    ),
  ].map(([, radiusX, radiusY, atX, atY, stop, fade]) => ({
    colour: colour(stop),
    radius: { x: Number(radiusX), y: Number(radiusY) },
    centre: { x: Number(atX) / 100, y: Number(atY) / 100 },
    fade: Number(fade) / 100,
  }));

  if (washes.length !== declared) {
    throw new Error(
      `--bg-image declares ${declared} radial washes, ${washes.length} read as a colour fading to transparent`,
    );
  }

  return washes;
}

/**
 * How much of a wash's alpha lands at its strongest point inside a viewport:
 * the point of the page nearest the gradient's centre, which for a centre above
 * the top edge is the top edge itself, where the page heading sits.
 */
function washDepth(wash: Wash, { width, height }: { width: number; height: number }): number {
  const centre = { x: wash.centre.x * width, y: wash.centre.y * height };
  const nearest = {
    x: Math.min(Math.max(centre.x, 0), width),
    y: Math.min(Math.max(centre.y, 0), height),
  };
  const from = Math.hypot(
    (nearest.x - centre.x) / wash.radius.x,
    (nearest.y - centre.y) / wash.radius.y,
  );

  return Math.max(0, 1 - from / wash.fade);
}

/** The washes as surfaces, each at the deepest it gets at any window size. */
function backgroundWashes(block: string): Colour[] {
  return pageWashes(block).map((wash) => ({
    rgb: wash.colour.rgb,
    alpha: wash.colour.alpha * Math.max(...WINDOW_SIZES.map((size) => washDepth(wash, size))),
  }));
}

/**
 * The EQ graph's background as painted: a glow radial over a surface
 * gradient, read from the `.eq-graph` rule and its per-theme overrides rather
 * than the tokens, because the light theme repaints both layers with its own
 * strengths. A background in any other shape leaves a layer out of the stack
 * the axis labels are measured on, so one that does not read whole is refused
 * rather than skipped.
 */
function graphLayers(source: string, theme: string, block: string): { glow: Colour; top: Colour; bottom: Colour } {
  const rules = [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const backgrounds = new Map<string, string>();
  const put = (key: string, value: string) => {
    if (backgrounds.has(key)) throw new Error(`two EQ graph backgrounds read for "${key}"`);
    backgrounds.set(key, value);
  };
  for (const rule of rules) {
    const selector = rule[1].replace(/\s+/g, ' ').trim();
    const background = rule[2]
      .split(';')
      .find((part) => part.slice(0, part.indexOf(':')).trim().toLowerCase() === 'background');
    if (!background) continue;
    if (selector === '.eq-graph') put('default', background.slice(background.indexOf(':') + 1));
    else if (selector.includes('.eq-graph')) {
      const override = selector.match(/^:root\[data-theme='([a-z0-9_-]+)'\] \.eq-graph$/);
      if (!override) throw new Error(`the EQ graph background in "${selector}" names no theme this reader knows`);
      put(override[1], background.slice(background.indexOf(':') + 1));
    }
  }

  const background = backgrounds.get(theme) ?? backgrounds.get('default');
  if (!background) throw new Error('the EQ graph paints no background to read');

  const paint = '(var\\(--[a-z0-9-]+\\)|#[0-9a-f]{6}|rgba?\\([^)]+\\))';
  const layers = background.trim().match(
    new RegExp(
      `^radial-gradient\\(\\s*[\\d.]+%\\s+[\\d.]+%\\s+at\\s+[\\d.]+%\\s+-?[\\d.]+%\\s*,\\s*${paint}\\s*,\\s*transparent\\s+[\\d.]+%\\s*\\)\\s*,\\s*` +
        `linear-gradient\\(\\s*180deg\\s*,\\s*${paint}\\s*,\\s*${paint}\\s*\\)$`,
      'i',
    ),
  );
  if (!layers) {
    throw new Error(`the EQ graph background reads in no shape this reader knows: ${background.trim()}`);
  }

  const resolve = (value: string): Colour => {
    const ref = value.trim().match(/^var\((--[a-z0-9-]+)\)$/i);
    return ref ? token(block, ref[1]) : colour(value.trim());
  };

  return { glow: resolve(layers[1]), top: resolve(layers[2]), bottom: resolve(layers[3]) };
}

/** Token names a theme block defines. */
const tokensIn = (block: string) => [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]);

/**
 * Tokens that paint no colour of their own: lines and borders, shadows, the
 * page's background image and geometry. The rail's washes are not here — their
 * stops are measured under the rail's text — and neither is --glow, which the
 * graph paints over its background under its labels. The other places --glow
 * appears are not surfaces text sits on: the input focus ring surrounds its
 * field, and the curve's drop-shadow follows its line.
 */
const NOT_TEXT = new Set([
  '--radius',
  '--rail',
  '--line',
  '--line-soft',
  '--line-strong',
  '--danger-border',
  '--glass-inner',
  '--bg-image',
  '--shadow-card',
  '--shadow-brand',
]);

/** Every token a check above names, directly or as a surface it measures. */
const MEASURED = new Set<string>([
  ...TEXT_PAIRS.flat(),
  ...ACCENT_FILLS,
  ...RING_SURFACES,
  '--primary-text',
  '--hint-bg',
  // Measured as the gradient the rail and its active item paint with.
  '--rail-bg',
  '--active-nav',
  // Measured as the radial the EQ graph paints over its background.
  '--glow',
]);

/**
 * A token added to a theme and forgotten would paint text nothing measures, so
 * every token has to be named by a pair above or declared as painting no text.
 */
describe('token coverage', () => {
  const defined = new Set(THEMES.flatMap(({ block }) => tokensIn(block)));

  it('measures every token, or records why it needs no measurement', () => {
    const unaccounted = [...defined].filter((name) => !MEASURED.has(name) && !NOT_TEXT.has(name));
    expect(unaccounted, 'tokens with no pair and no exemption').toEqual([]);
  });

  it('keeps the not-text list to tokens that exist', () => {
    expect([...NOT_TEXT].filter((name) => !defined.has(name))).toEqual([]);
  });
});

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

/** Keys that paint, in the camelCase that JSX and style objects use. */
const STYLE_KEYS = [
  'backgroundColor',
  'background',
  'borderColor',
  'outlineColor',
  'textDecorationColor',
  'fill',
  'stroke',
  'stopColor',
  'floodColor',
  'color',
  'caretColor',
];

/** A key and the `:` or `=` that opens its value, in JSX or in an object. */
const COLOUR_KEY = new RegExp(`\\b(${STYLE_KEYS.join('|')})(\\s*[:=])\\s*`, 'g');
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
    if (reported.has(index)) return;
    reported.add(index);
    offences.push({ index, fragment: fragment.trim() });
  };

  /** A colour named inside a value: `hot ? 'red' : undefined`. */
  const flagNames = (value: string, at: number, property: string) => {
    for (const inner of value.matchAll(QUOTED)) {
      if (!namesColour(inner[2])) continue;
      note(at + (inner.index ?? 0), `${property}: ${inner[0]}`);
    }
  };

  for (const match of text.matchAll(RAW_COLOUR)) note(match.index ?? 0, match[0]);

  /**
   * A value that is one quoted string is checked whole; anything else is an
   * expression, whose strings only matter if one of them names a colour.
   * `written` is how the value reads at its key, for the report.
   */
  const checkValue = (raw: string, at: number, property: string, written: string) => {
    const single = raw.match(/^(['"])((?:[^'"\\]|\\.)*)\1$/);

    if (!single) {
      flagNames(raw, at, property);
    } else if (!THEMED_VALUE.test(single[2].trim())) {
      note(at, written);
    }
  };

  // Every key that paints, whether written as a JSX attribute or a style
  // property, and whether it was handed a string or an expression.
  for (const match of text.matchAll(COLOUR_KEY)) {
    const [, property, separator] = match;
    const start = (match.index ?? 0) + match[0].length;

    if (separator.trim() !== '=') {
      const { value, at } = valueAt(text, start);
      checkValue(value, at, property, `${property}: ${value}`);
      continue;
    }

    const opener = text[start];

    if (opener === '{') {
      const { value, at } = valueAt(text, start + 1);
      checkValue(value, at, property, `${property}: ${value}`);
    } else if (opener === '"' || opener === "'") {
      const close = text.indexOf(opener, start + 1);
      if (close === -1) continue;

      const raw = text.slice(start, close + 1);
      checkValue(raw, start, property, `${property}=${raw}`);
    }
  }

  // Strings then carry what no key can see: a bare name kept in a constant, or
  // a stylesheet built as a template, whose declarations are read as CSS.
  for (const match of text.matchAll(QUOTED)) {
    const index = match.index ?? 0;

    if (namesColour(match[2])) {
      note(index, match[0]);
      continue;
    }

    for (const colour of cssColours(match[2], index + 1)) note(colour.index, colour.fragment);
  }

  // The checks run key by key, so their findings are sorted back into source
  // order: a failure then reads down the file instead of jumping around.
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

  it('refuses a root block it cannot name', () => {
    // In a selector list the theme would never be read; twice over, two blocks
    // would be measured under one title.
    expect(() => themesIn(':root, :root[data-theme="sepia"] {\n  --bg: #fff8ee;\n}')).toThrow(
      /root blocks/,
    );
    expect(() => themesIn(':root {\n  --bg: #000000;\n}\n:root {\n  --bg: #111111;\n}')).toThrow(
      /two theme blocks/,
    );
  });

  it('reads a page wash as a colour fading to transparent', () => {
    const block =
      '--bg-image: radial-gradient(1100px 650px at 10% -10%, rgba(26, 111, 212, 0.12), transparent 60%);';

    const [wash] = backgroundWashes(block);
    expect(wash.rgb).toEqual([26, 111, 212]);
    // Deeper than nothing, and shallower than the declared stop, which is only
    // reached off-canvas.
    expect(wash.alpha).toBeGreaterThan(0);
    expect(wash.alpha).toBeLessThanOrEqual(0.12);
  });

  it('refuses a page wash it cannot read whole', () => {
    const swapped =
      '--bg-image: radial-gradient(1100px 650px at 10% -10%, transparent 60%, rgba(26, 111, 212, 0.12));';
    const third =
      '--bg-image: radial-gradient(1100px 650px at 10% -10%, rgba(26, 111, 212, 0.12), transparent 60%, rgba(0, 0, 0, 0.2));';
    const hex = '--bg-image: radial-gradient(1100px 650px at 10% -10%, #1a6fd4, transparent 60%);';

    // Each would otherwise leave a wash out of the measurement without a word.
    for (const block of [swapped, third, hex]) {
      expect(() => backgroundWashes(block), block).toThrow(/radial washes/);
    }
  });

  it('reads the graph background, following a theme override', () => {
    const block =
      '--bg: #f5f8fd; --surface: rgba(255, 255, 255, 0.92); --surface-soft: rgba(255, 255, 255, 0.7); --glow: rgba(26, 111, 212, 0.18);';
    const base =
      ':root {\n' +
      `  ${block}\n` +
      '}\n' +
      '.eq-graph {\n' +
      '  background:\n' +
      '    radial-gradient(120% 90% at 50% -25%, var(--glow), transparent 62%),\n' +
      '    linear-gradient(180deg, var(--surface), var(--surface-soft));\n' +
      '}';

    // Tokens where the rule names them.
    expect(graphLayers(base, 'default', block).glow).toEqual(token(block, '--glow'));
    expect(graphLayers(base, 'default', block).bottom).toEqual(token(block, '--surface-soft'));
    // A theme with no override of its own falls back to the base rule.
    expect(graphLayers(base, 'sepia', block).glow).toEqual(token(block, '--glow'));

    const themed =
      base +
      '\n:root[data-theme=\'light\'] .eq-graph {\n' +
      '  background:\n' +
      '    radial-gradient(120% 90% at 50% -25%, rgba(26, 111, 212, 0.07), transparent 62%),\n' +
      '    linear-gradient(180deg, #ffffff, #f6f9fd);\n' +
      '}';

    // Literals where the override repaints the layers with its own strengths.
    expect(graphLayers(themed, 'light', block).glow).toEqual(colour('rgba(26, 111, 212, 0.07)'));
    expect(graphLayers(themed, 'light', block).bottom).toEqual(colour('#f6f9fd'));
  });

  it('refuses a graph background it cannot read whole', () => {
    const block = '--bg: #f5f8fd; --surface: rgba(255, 255, 255, 0.92); --surface-soft: rgba(255, 255, 255, 0.7); --glow: rgba(26, 111, 212, 0.18);';
    const background =
      'radial-gradient(120% 90% at 50% -25%, var(--glow), transparent 62%), ' +
      'linear-gradient(180deg, var(--surface), var(--surface-soft))';
    const sheet = (painted: string) => `:root {\n  ${block}\n}\n.eq-graph {\n  background: ${painted};\n}`;

    // Each would otherwise leave a layer out of the stack the labels sit on.
    const swapped = background.replace('var(--glow), transparent 62%', 'transparent 62%, var(--glow)');
    const third = background.replace('transparent 62%), linear', 'transparent 62%, rgba(0, 0, 0, 0.2)), linear');
    for (const painted of [swapped, third]) {
      expect(() => graphLayers(sheet(painted), 'default', block), painted).toThrow(/no shape/);
    }
  });
});

/** The surfaces the pairs are measured on, each translucent one composited. */
function surfacesOf(block: string, theme: string, source = css): Record<string, Colour> {
  // The graph's glow at its full strength, which the radial only reaches near
  // the top edge: everywhere else the labels sit on less of it, so measuring
  // the full layer errs towards the stricter check.
  const graph = graphLayers(source, theme, block);
  const graphTop = over(graph.top, token(block, '--bg'));
  const graphBottom = over(graph.bottom, token(block, '--bg'));
  return {
    '--bg': token(block, '--bg'),
    '--bg-2': token(block, '--bg-2'),
    // Translucent surfaces are measured where they are painted: on a card for
    // the hint and danger boxes, on the page for the rest.
    '--hint': over(token(block, '--hint-bg'), token(block, '--bg-2')),
    '--danger-bg': over(token(block, '--danger-bg'), token(block, '--bg-2')),
    '--readout': over(token(block, '--readout'), token(block, '--bg')),
    '--panel': over(token(block, '--panel'), token(block, '--bg')),
    '--panel-strong': over(token(block, '--panel-strong'), token(block, '--bg')),
    '--surface': over(token(block, '--surface'), token(block, '--bg')),
    '--surface-soft': over(token(block, '--surface-soft'), token(block, '--bg')),
    '--graph': over(graph.glow, graphTop),
    '--graph-soft': over(graph.glow, graphBottom),
    '--active-soft': over(token(block, '--active-soft'), token(block, '--bg')),
    '--active-strong': over(token(block, '--active-strong'), token(block, '--bg')),
  };
}

describe.each(THEMES)('$theme theme', ({ theme, block }) => {
  const surfaces = surfacesOf(block, theme);

  it.each(TEXT_PAIRS)('keeps %s readable on %s', (fgToken, bgToken) => {
    const ratio = contrast(token(block, fgToken), surfaces[bgToken]);
    expect(ratio, `${fgToken} on ${bgToken} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps text readable across the accent fill, both ends of the gradient', () => {
    // The primary button fills with --accent-2 to --accent; the rail's count is
    // --accent alone. The text has to clear AA against every end of that.
    const text = token(block, '--primary-text');
    for (const fill of ACCENT_FILLS) {
      const ratio = contrast(text, token(block, fill));
      expect(ratio, `--primary-text on ${fill} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the focus ring visible on the page and on the panel', () => {
    // A non-text indicator only needs 3:1, but it is drawn in the same teal as
    // the labels, so it should not be the thing that looks faint. On the page it
    // is the rail count's ring; on the panel, the QueuePanel buttons'.
    for (const surface of RING_SURFACES) {
      const ratio = contrast(token(block, '--accent-2'), token(block, surface));
      expect(ratio, `--accent-2 on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(UI_PAIRS)('keeps the %s UI colour visible on %s', (fgToken, bgToken) => {
    // Non-text UI is held to 3:1, not 4.5:1: these are shapes and edges, and a
    // token lightened for a fill still has to stay visible against what it draws on.
    const ratio = contrast(token(block, fgToken), surfaces[bgToken]);
    expect(ratio, `${fgToken} on ${bgToken} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });

  it('keeps rail text readable over the rail wash and the page beneath it', () => {
    // The rail is a translucent white wash, and the page gradient's washes show
    // through it, so rail labels sit on a lighter surface than flat --bg.
    const railStops = gradientStops(block, '--rail-bg');
    expect(railStops.length, '--rail-bg declares no colour stops').toBeGreaterThan(0);

    const pages = [
      ...RING_SURFACES.map((surface) => token(block, surface)),
      ...RING_SURFACES.flatMap((surface) =>
        backgroundWashes(block).map((wash) => over(wash, token(block, surface))),
      ),
    ];

    // The active nav item lays its own tint over the rail, so its labels sit
    // two layers deep; the other rail text sits on the rail wash alone.
    const nav = gradientStops(block, '--active-nav');
    const onRail = railStops.map((rail) => [rail]);
    const onActive = [...onRail, ...railStops.flatMap((rail) => nav.map((tint) => [rail, tint]))];

    for (const [fg, onActiveTint] of RAIL_TEXT) {
      for (const stack of onActiveTint ? onActive : onRail) {
        for (const page of pages) {
          const surface = stack.reduce((under, layer) => over(layer, under), page);
          const ratio = contrast(token(block, fg), surface);
          const painted = stack.map((layer) => `${layer.alpha.toFixed(3)}`).join(' over ');
          expect(ratio, `${fg} under ${painted} on the rail is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('keeps text readable where the page gradient is strongest', () => {
    // The page is not a flat --bg: two accent washes sit over a --bg-2 to --bg
    // ramp, and text near the top of the window lands in them.
    const washes = backgroundWashes(block);
    expect(washes.length, 'the page background has no washes to check').toBeGreaterThan(0);

    for (const fg of PAGE_TEXT) {
      for (const wash of washes) {
        for (const base of RING_SURFACES) {
          const ratio = contrast(token(block, fg), over(wash, token(block, base)));
          expect(
            ratio,
            `${fg} on ${base} under rgb(${wash.rgb.join(',')}) at ${wash.alpha.toFixed(3)} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe('the window the page gradient is measured in', () => {
  it('takes its sizes from the Electron window, smallest first', () => {
    const [smallest, opened] = WINDOW_SIZES;
    expect(smallest.width, 'the smallest window has no width').toBeGreaterThan(0);
    expect(smallest.height, 'the smallest window has no height').toBeGreaterThan(0);
    // The minimum is measured with the frame taken off, so it has to come out
    // below the opened size; a parse that read the wrong numbers would not.
    expect(smallest.height).toBeLessThan(opened.height);
  });

  it('finds no wash deeper than in the smallest window', () => {
    // This is what makes the two sizes the whole range: a window bigger than the
    // smallest is never worse, so enumerating larger ones would measure nothing.
    const [smallest, opened] = WINDOW_SIZES;

    for (const { theme, block } of THEMES) {
      for (const wash of pageWashes(block)) {
        expect(
          washDepth(wash, opened),
          `${theme}: a wash is deeper in the opened window than in the smallest`,
        ).toBeLessThanOrEqual(washDepth(wash, smallest));
      }
    }
  });
});

/** Every token the text gates measure as the painted colour. */
const TEXT_TOKENS = [...new Set([...TEXT_PAIRS.map(([fg]) => fg), '--primary-text'])];

/** The surface each text token is first measured against, which it can be set to. */
const TEXT_SURFACE = new Map<string, string>();
for (const [fg, bg] of TEXT_PAIRS) if (!TEXT_SURFACE.has(fg)) TEXT_SURFACE.set(fg, bg);
TEXT_SURFACE.set('--primary-text', '--accent');

/** Every text gate of one theme, with the ratio it measured. */
function textGates(block: string, theme: string, source = css): Array<{ label: string; ratio: number }> {
  const surfaces = surfacesOf(block, theme, source);
  const rows: Array<{ label: string; ratio: number }> = [];
  const gate = (label: string, ratio: number) => rows.push({ label, ratio });

  for (const [fg, bg] of TEXT_PAIRS) gate(`${fg} on ${bg}`, contrast(token(block, fg), surfaces[bg]));
  for (const fill of ACCENT_FILLS) {
    gate(`--primary-text on ${fill}`, contrast(token(block, '--primary-text'), token(block, fill)));
  }

  // The same page and rail surfaces the tests above paint text on.
  const washes = backgroundWashes(block);
  const pages = [
    ...RING_SURFACES.map((surface) => token(block, surface)),
    ...RING_SURFACES.flatMap((surface) => washes.map((wash) => over(wash, token(block, surface)))),
  ];

  for (const fg of PAGE_TEXT) {
    for (const wash of washes) {
      for (const base of RING_SURFACES) {
        gate(
          `${fg} on ${base} under a ${wash.alpha.toFixed(3)} wash`,
          contrast(token(block, fg), over(wash, token(block, base))),
        );
      }
    }
  }

  const railStops = gradientStops(block, '--rail-bg');
  const nav = gradientStops(block, '--active-nav');
  const onRail = railStops.map((rail) => [rail]);
  const onActive = [...onRail, ...railStops.flatMap((rail) => nav.map((tint) => [rail, tint]))];

  for (const [fg, onActiveTint] of RAIL_TEXT) {
    for (const stack of onActiveTint ? onActive : onRail) {
      for (const page of pages) {
        const surface = stack.reduce((under, layer) => over(layer, under), page);
        gate(
          `${fg} on the rail at ${stack.map((layer) => layer.alpha.toFixed(3)).join(' over ')}`,
          contrast(token(block, fg), surface),
        );
      }
    }
  }

  return rows;
}

/** The text gates that fall below `bar`, as the failures the tests would report. */
function textFailures(block: string, theme: string, bar = 4.5, source = css): string[] {
  return textGates(block, theme, source)
    .filter(({ ratio }) => ratio < bar)
    .map(({ label, ratio }) => `${label} is ${ratio.toFixed(2)}:1`);
}

/**
 * A stylesheet with one token set, in every theme, to the colour it is measured
 * against — the one value no threshold in here can pass. It is a string, not a
 * file: the guard's own readers are pointed at the weakened copy.
 */
function weakened(source: string, name: string, against: string): string {
  const themes = themesIn(source);
  let out = source;
  let rewritten = 0;

  for (const { block } of themes) {
    const replacement = tokenText(block, against);
    // A declaration only: `var(--text)` and `--text-2:` do not match.
    const next = block.replace(
      new RegExp(`(${name}\\s*:\\s*)[^;]+;`, 'g'),
      (_declaration, head: string) => `${head}${replacement};`,
    );
    if (next === block) continue;

    rewritten += 1;
    out = out.replace(block, () => next);
  }

  if (rewritten !== themes.length) {
    throw new Error(`${name} was rewritten in ${rewritten} of ${themes.length} theme blocks`);
  }

  return out;
}

/**
 * A green run only means something while the guard still reads the stylesheet.
 * Each text token is weakened in memory, one at a time, to the colour behind it
 * and a failure is required, so a scan that stops matching, a token the reader
 * quietly stops finding, or a threshold that drifts fails here instead of
 * leaving checks that run zero times and pass.
 */
describe('what the guard catches', () => {
  it('finds the theme blocks the checks are built from', () => {
    // `describe.each` over an empty list passes silently, which is exactly the
    // failure the rest of this block exists to make loud.
    expect(THEMES.length, 'no theme block parsed, so every colour check ran zero times').toBeGreaterThan(0);
    expect(themesIn(css).map(({ theme }) => theme)).toEqual(THEMES.map(({ theme }) => theme));
  });

  it('reports nothing for the stylesheet as it stands', () => {
    // Ties the weakened runs to the real gates: if this mirror drifts from the
    // tests above, the file itself starts failing here.
    const failures = THEMES.flatMap(({ theme, block }) =>
      textFailures(block, theme).map((failure) => `${theme}: ${failure}`),
    );
    expect(failures).toEqual([]);
  });

  it.each(TEXT_TOKENS)('fails when %s is weakened to the colour behind it', (name) => {
    const against = TEXT_SURFACE.get(name);
    expect(against, `${name} is measured on no surface`).toBeDefined();

    const source = weakened(css, name, against as string);
    expect(source, `${name} was not rewritten, so nothing was weakened`).not.toBe(css);

    const themes = themesIn(source);
    expect(themes.length, 'the weakened copy no longer parses into theme blocks').toBe(THEMES.length);

    const failures = themes.flatMap(({ theme, block }) =>
      textFailures(block, theme, 4.5, source).map((failure) => `${theme}: ${failure}`),
    );
    expect(failures, `${name} was weakened and no check failed`).not.toEqual([]);
    // The failure has to be about the token that was weakened, not some other
    // colour that happened to break with it.
    expect(failures.join(' '), `no failure names ${name}`).toContain(name);
  });
});

/**
 * How far above the AA floor a pair has to sit. A colour that clears 4.5:1 by a
 * hundredth is a colour nobody can see going wrong: the next small tweak takes
 * it under and the first sign is a red run. This keeps a margin, and prints the
 * tightest pairs, so a slide is readable in the log while it is still a slide.
 */
const MARGIN = 0.2;

describe.each(THEMES)('$theme theme margin', ({ theme, block }) => {
  it('clears the AA floor by a visible margin', () => {
    const tightest = textGates(block, theme)
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 3)
      .map(({ label, ratio }) => `${label} ${ratio.toFixed(2)}:1 (+${(ratio - 4.5).toFixed(2)})`);

    console.info(`${theme}: tightest text pairs — ${tightest.join('; ')}`);

    expect(textFailures(block, theme, 4.5 + MARGIN)).toEqual([]);
  });
});
