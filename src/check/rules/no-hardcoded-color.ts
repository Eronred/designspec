import { COLOR_IN_TEXT, isTransparent, nearestColorToken, nearestColorTokenFor, parseColor } from "../../color.js";
import { type Config, hasTailwind } from "../../config.js";
import { propertyKey, walk } from "../../source.js";
import type { Token } from "../../spec.js";
import { arbitraryValue, tokenizeClasses } from "../classes.js";
import { collectStyleProperties } from "../styles.js";
import type { FileRule } from "../types.js";

// fill, stroke, color, bg (Chakra, Mantine), background, and every *Color prop (borderColor, tintColor, stopColor…).
const COLOR_PROP = /^(fill|stroke|color|bg|bgcolor|background)$|Color$/;

export function isColorProp(name: string, config: Config): boolean {
  return COLOR_PROP.test(name) || (name === "c" && config.presets.includes("mantine"));
}
const KEYWORDS = /^(transparent|currentcolor|inherit|none)$/i;
const neutral = (value: string) => KEYWORDS.test(value) || isTransparent(value);

export const noHardcodedColor: FileRule = {
  id: "no-hardcoded-color",
  description: "Disallow hex/rgb/hsl/oklch colors in classes, style objects (incl. StyleSheet.create) and color props.",
  defaultLevel: "error",
  runsInUiDir: false,
  check(ctx) {
    if (hasTailwind(ctx.config)) {
      for (const classString of ctx.classStrings) {
        for (const token of tokenizeClasses(classString)) {
          const arbitrary = arbitraryValue(token.utility);
          if (!arbitrary || arbitrary.value.includes("var(") || isTransparent(arbitrary.value)) continue;
          if (!parseColor(arbitrary.value) && !COLOR_IN_TEXT.test(arbitrary.value)) continue;
          const near = nearestColorTokenFor(arbitrary.prefix, arbitrary.value, ctx.spec.tokens);
          // Without a Tailwind utility the token is still usable as an arbitrary value: text-[var(--brand)].
          const replacement =
            near && (arbitrary.prefix.startsWith("[") ? reference(near) : near.utility ? `${arbitrary.prefix}-${near.utility}` : `${arbitrary.prefix}-[${reference(near)}]`);
          ctx.report(token.index, `Hardcoded color "${token.raw}".`, suggest(replacement, near));
        }
      }
    }

    const reported = new Set<number>();
    for (const { key, value } of collectStyleProperties(ctx.ast)) {
      if (value.type !== "StringLiteral" || neutral(value.value)) continue;
      // Color-named keys may hold named colors (`color: "white"`); elsewhere look for color syntax (`border: "1px solid #ccc"`).
      const color = /color$/i.test(key) && parseColor(value.value) ? value.value : COLOR_IN_TEXT.exec(value.value)?.[0];
      if (!color) continue;
      const near = nearestColorToken(color, ctx.spec.tokens);
      reported.add(value.start!);
      ctx.report(value.start! + 1, `Hardcoded color in style: ${key}: "${value.value}".`, suggest(near && reference(near), near));
    }

    walk(ctx.ast, (node) => {
      // Color-named keys outside style objects: `{ label: "Sales", color: "#10b981" }` passed around as data.
      if (node.type === "ObjectProperty" && node.value.type === "StringLiteral" && !reported.has(node.value.start!)) {
        const key = propertyKey(node.key);
        const value = node.value.value;
        if (!key || !/color$/i.test(key) || neutral(value) || !(COLOR_IN_TEXT.test(value) || /^[a-z]+$/i.test(value)) || !parseColor(value)) return;
        const near = nearestColorToken(value, ctx.spec.tokens);
        ctx.report(node.value.start! + 1, `Hardcoded color ${key}: "${value}".`, suggest(near && reference(near), near));
        return;
      }
      if (node.type !== "JSXAttribute" || node.name.type !== "JSXIdentifier" || !isColorProp(node.name.name, ctx.config)) return;
      const value = node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
      if (value?.type !== "StringLiteral" || neutral(value.value) || !parseColor(value.value)) return;
      const near = nearestColorToken(value.value, ctx.spec.tokens);
      ctx.report(value.start! + 1, `Hardcoded color ${node.name.name}="${value.value}".`, suggest(near && reference(near), near));
    });
  },
};

/**
 * How code should reference a token: the theme name style props take (`brand.500` in Chakra, Mantine, MUI),
 * `colors.label` for JS themes, `var(--primary)` for CSS.
 */
function reference(token: Token): string {
  if (token.utility?.includes(".")) return token.utility;
  return token.code ?? `var(${token.cssVar ?? `--${token.name}`})`;
}

function suggest(replacement: string | undefined, near: Token | undefined): string {
  if (!replacement || !near) return "Use a color token. If none fits, run `designspec propose` to add one.";
  return near.cssVar && !replacement.includes(near.cssVar) ? `Closest token: ${replacement} (${near.cssVar}).` : `Closest token: ${replacement}.`;
}
