import { isPlain } from './shape.js';
import type { TokenWarning } from './studio-read.js';

/**
 * The token check (US-17, AB-142.1): every color, font and font size a variant's pages use, and the ones its design
 * system's tokens lack. The Studio store runs it once, when it saves a variant; reading only shows what was saved.
 *
 * What it reads: the CSS in the pages' <style> tags and style="" attributes. Colors are #hex, rgb(), hsl() and the
 * other color functions, and the common color names (red, blue …) in color properties; a token color at another
 * opacity (a shadow of the ink color) counts as the token. Fonts are the families in font-family and font; the generic
 * ones (sans-serif, system-ui …) always count. Sizes are font sizes. A kind the tokens say nothing about (no color, no
 * font, no font size) is not checked: a design system without fonts does not ask for any.
 */

const MAX_WARNINGS = 24;

/** The color names a page may write, with their color, to compare with the tokens. */
const NAMED: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', orange: 'ffa500',
  purple: '800080', pink: 'ffc0cb', brown: 'a52a2a', gray: '808080', grey: '808080', navy: '000080', teal: '008080',
  lime: '00ff00', maroon: '800000', olive: '808000', silver: 'c0c0c0', aqua: '00ffff', cyan: '00ffff', fuchsia: 'ff00ff',
  magenta: 'ff00ff', crimson: 'dc143c', tomato: 'ff6347', gold: 'ffd700', coral: 'ff7f50', salmon: 'fa8072',
  indigo: '4b0082', violet: 'ee82ee', darkred: '8b0000', firebrick: 'b22222', orangered: 'ff4500', hotpink: 'ff69b4',
};

/** Families that are the browser's own, never a design choice to check. */
const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'revert',
]);

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi;
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/gi;
const NAMED_WORD = new RegExp(`(?<![\\w-])(?:${Object.keys(NAMED).join('|')})(?![\\w-])`, 'gi');
/** Properties where a plain word can be a color name. */
const COLOR_PROP = /color|background|border|outline|fill|stroke|shadow|text-decoration|caret|accent|column-rule|^--/;
const LENGTH = /(?<![\w.#-])-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|pt|%)(?![\w%])/gi;
const SIZE_WORDS = /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller)$/i;

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** A color's own key, without its opacity: "ff0000"; or the written function in lower case when it cannot be worked out. */
function colorKey(written: string): string {
  const c = written.trim().toLowerCase();
  if (c.startsWith('#')) {
    const h = c.slice(1);
    const full = h.length <= 4 ? [...h].map((x) => x + x).join('') : h;
    return full.slice(0, 6);
  }
  if (NAMED[c]) return NAMED[c]!;
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(c);
  const nums = fn ? fn[2]!.split(/[\s,/]+/).filter(Boolean) : [];
  if (fn && nums.length >= 3) {
    const n = (s: string, max: number) => (s.endsWith('%') ? (parseFloat(s) / 100) * max : parseFloat(s));
    if (fn[1]!.startsWith('rgb')) {
      const [r, g, b] = nums.slice(0, 3).map((s) => n(s, 255));
      if ([r, g, b].every((x) => Number.isFinite(x))) return hex2(r!) + hex2(g!) + hex2(b!);
    } else {
      const h = (((parseFloat(nums[0]!) % 360) + 360) % 360) / 360;
      const s = parseFloat(nums[1]!) / 100;
      const l = parseFloat(nums[2]!) / 100;
      if ([h, s, l].every((x) => Number.isFinite(x))) {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const t = (x: number) => {
          const k = x < 0 ? x + 1 : x > 1 ? x - 1 : x;
          if (k < 1 / 6) return p + (q - p) * 6 * k;
          if (k < 1 / 2) return q;
          if (k < 2 / 3) return p + (q - p) * (2 / 3 - k) * 6;
          return p;
        };
        return hex2(t(h + 1 / 3) * 255) + hex2(t(h) * 255) + hex2(t(h - 1 / 3) * 255);
      }
    }
  }
  return c.replace(/\s+/g, ' ');
}

/** The colors written in one CSS value, as written. Plain color names count only in color properties. */
function colorsIn(value: string, prop: string): string[] {
  const v = value.replace(/url\([^)]*\)/gi, ' ');
  const out = [...(v.match(HEX) ?? []), ...(v.match(COLOR_FN) ?? [])];
  if (COLOR_PROP.test(prop)) out.push(...(v.match(NAMED_WORD) ?? []));
  return out;
}

/** "16px", ".5rem" and "0.50rem" are the same size: its number and its unit. */
function lengthKey(written: string): string {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]+)$/i.exec(written.trim());
  return m ? `${parseFloat(m[1]!)}${m[2]!.toLowerCase()}` : written.trim().toLowerCase();
}

/** A font family's own name: no quotes, lower case. */
const fontKey = (f: string) => f.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();

function familiesIn(list: string): string[] {
  return list
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').trim())
    .filter((f) => f && !/^var\(/i.test(f) && !GENERIC_FONTS.has(f.toLowerCase()));
}

/** The family list and the size in a `font:` shorthand, when it has them. */
function fontShorthand(value: string): { families?: string; size?: string } {
  const m = /(?:^|\s)((?:-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|pt|%))|xx-small|x-small|small|medium|large|x-large|xx-large|larger|smaller)(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(value.trim());
  return m ? { size: m[1]!, families: m[2]! } : {};
}

/** Every CSS declaration in a page: from its <style> tags and its style="" attributes. */
function declarations(html: string): { prop: string; value: string }[] {
  const css: string[] = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css.push(m[1]!);
  for (const m of html.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) css.push(m[2] ?? m[3] ?? '');
  const out: { prop: string; value: string }[] = [];
  for (const block of css) {
    const text = block.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    for (const part of text.split(/[;{}]/)) {
      const at = part.indexOf(':');
      if (at < 1) continue;
      const prop = part.slice(0, at).trim().toLowerCase();
      // A selector with a pseudo-class ("a:hover") has no value after it, only the start of a block: it has no space.
      if (!/^(?:--)?[a-z-]+$/.test(prop)) continue;
      const value = part.slice(at + 1).replace(/!important/i, '').trim();
      if (value) out.push({ prop, value });
    }
  }
  return out;
}

/** What the tokens hold: their color keys, their font families, their lengths, and whether they name fonts and font sizes. */
function tokenValues(tokens: unknown): { colors: Set<string>; fonts: Set<string>; lengths: Set<string>; hasFonts: boolean; hasSizes: boolean } {
  const out = { colors: new Set<string>(), fonts: new Set<string>(), lengths: new Set<string>(), hasFonts: false, hasSizes: false };
  const walk = (x: unknown, keys: string, depth: number) => {
    if (depth > 8) return;
    if (typeof x === 'number' && Number.isFinite(x) && /size|font|text|type|scale/i.test(keys)) {
      out.lengths.add(lengthKey(`${x}px`));
      out.hasSizes = true;
    } else if (typeof x === 'string') {
      // A color name counts only as the whole token: "Red Hat Display" is a font, not red.
      const colors = [...colorsIn(x, 'token'), ...(NAMED[x.trim().toLowerCase()] ? [x] : [])];
      for (const c of colors) out.colors.add(colorKey(c));
      const lengths = x.match(LENGTH) ?? [];
      for (const l of lengths) out.lengths.add(lengthKey(l));
      if (lengths.length && /size|font|text|type|scale|heading|body/i.test(keys)) out.hasSizes = true;
      // A family is a token under a font key that is neither a size, a weight nor a color.
      if (/font|famil|typeface/i.test(keys) && !lengths.length && !/^\d+$/.test(x.trim()) && !colors.length) {
        out.hasFonts = true;
        for (const f of x.split(',')) if (fontKey(f)) out.fonts.add(fontKey(f));
      }
    } else if (Array.isArray(x)) x.forEach((v) => walk(v, keys, depth + 1));
    else if (isPlain(x)) for (const [k, v] of Object.entries(x)) walk(v, `${keys}.${k}`, depth + 1);
  };
  walk(tokens, '', 0);
  return out;
}

/**
 * The colors, fonts and font sizes the pages use that the tokens lack, each once, as the page first writes it: colors,
 * then fonts, then sizes. Empty when the pages keep to the tokens.
 */
export function tokenWarnings(pages: string[], tokens: Record<string, unknown>): TokenWarning[] {
  const t = tokenValues(tokens);
  const out: TokenWarning[] = [];
  const seen = new Set<string>();
  const add = (kind: TokenWarning['kind'], value: string, key: string) => {
    if (seen.has(`${kind}:${key}`) || out.length >= MAX_WARNINGS) return;
    seen.add(`${kind}:${key}`);
    out.push({ kind, value: value.trim() });
  };
  const fonts: [string, string][] = [];
  const sizes: [string, string][] = [];
  for (const html of pages) {
    for (const { prop, value } of declarations(html)) {
      for (const c of colorsIn(value, prop)) {
        const key = colorKey(c);
        if (t.colors.size && !t.colors.has(key)) add('color', c, key);
      }
      if (prop === 'font-family') for (const f of familiesIn(value)) fonts.push([f, fontKey(f)]);
      if (prop === 'font') {
        const s = fontShorthand(value);
        if (s.families) for (const f of familiesIn(s.families)) fonts.push([f, fontKey(f)]);
        if (s.size) sizes.push([s.size, lengthKey(s.size)]);
      }
      if (prop === 'font-size') sizes.push([value, lengthKey(value)]);
    }
  }
  if (t.hasFonts) for (const [f, key] of fonts) if (!t.fonts.has(key)) add('font', f, key);
  if (t.hasSizes) {
    for (const [s, key] of sizes) {
      // Only a plain length is a size choice: a keyword, var(), calc() or clamp() is left alone.
      if (SIZE_WORDS.test(s.trim()) || !/^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|pt|%)$/i.test(s.trim())) continue;
      if (!t.lengths.has(key)) add('size', s, key);
    }
  }
  return out;
}
