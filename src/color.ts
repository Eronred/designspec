import { differenceCiede2000, parse, type Color } from "culori";
import type { Token } from "./spec.js";

// shadcn on Tailwind v3 stores colors as bare HSL channels: `--primary: 222.2 47.4% 11.2%;`
const HSL_CHANNELS = /^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/;
const NOT_A_LITERAL = /^(currentcolor|inherit|initial|unset|none)$/i;
// culori reads hex digits without `#` as a color: a font weight of 400 or a radius of 9999 isn't one.
const BARE_HEX = /^[0-9a-f]{3,8}$/i;

/** Matches a color literal anywhere inside a longer value, e.g. `1px solid #ccc`. */
export const COLOR_IN_TEXT = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/i;

export function parseColor(value: string): Color | undefined {
  const v = value.trim().replace(/_/g, " ");
  if (!v || NOT_A_LITERAL.test(v) || BARE_HEX.test(v) || v.startsWith("var(")) return undefined;
  const channels = HSL_CHANNELS.exec(v);
  try {
    return parse(channels ? `hsl(${channels[1]} ${channels[2]}% ${channels[3]}%)` : v) ?? undefined;
  } catch {
    // culori throws on some non-color inputs, e.g. `calc(100dvh-3.5rem)`.
    return undefined;
  }
}

/** `rgba(0,0,0,0)`, `#0000` and the like: the same as `transparent`, so not a hardcoded color. */
export function isTransparent(value: string): boolean {
  return parseColor(value)?.alpha === 0;
}

const distance = differenceCiede2000();
const MAX_SUGGEST_DISTANCE = 15;

const TEXT_UTILITY = /^(text|fill|stroke|placeholder|caret|decoration)$/;
const FOREGROUND_TOKEN = /(foreground|-fg\b|^fg\b|text|label)/;

/**
 * Closest color token for a Tailwind utility prefix, preferring tokens meant for that role:
 * foreground tokens for `text-*`, surface tokens for `bg-*`. `text-white` should become
 * `text-primary-foreground`, not `text-card`, even if `card` happens to be closer.
 */
export function nearestColorTokenFor(prefix: string, value: string, tokens: Token[]): Token | undefined {
  const wantsForeground = TEXT_UTILITY.test(prefix);
  const sameRole = tokens.filter((t) => FOREGROUND_TOKEN.test(t.name) === wantsForeground);
  return nearestColorToken(value, sameRole) ?? nearestColorToken(value, tokens);
}

/** Color tokens ordered by visual distance to `value` (CIEDE2000), closest first. */
export function rankColorTokens(value: string, tokens: Token[], limit = 5): Array<{ token: Token; distance: number }> {
  const target = parseColor(value);
  if (!target) return [];
  const ranked: Array<{ token: Token; distance: number }> = [];
  for (const token of tokens) {
    const color = token.type === "color" ? parseColor(token.value) : undefined;
    if (color) ranked.push({ token, distance: distance(target, color) });
  }
  return ranked.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

/** The color token visually closest to `value`, if one is reasonably close. */
export function nearestColorToken(value: string, tokens: Token[]): Token | undefined {
  const target = parseColor(value);
  if (!target) return undefined;
  let best: Token | undefined;
  let bestDistance = Infinity;
  for (const token of tokens) {
    if (token.type !== "color") continue;
    const color = parseColor(token.value);
    // A translucent scrim is not a substitute for an opaque color, however close the hue.
    if (!color || Math.abs((color.alpha ?? 1) - (target.alpha ?? 1)) > 0.1) continue;
    const d = distance(target, color);
    // On a tie, prefer a token with a utility (bg-primary) over a raw primitive.
    if (d < bestDistance - 0.01 || (Math.abs(d - bestDistance) <= 0.01 && token.utility && !best?.utility)) {
      best = token;
      bestDistance = d;
    }
  }
  return bestDistance <= MAX_SUGGEST_DISTANCE ? best : undefined;
}
