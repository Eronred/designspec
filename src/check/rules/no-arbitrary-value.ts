import { COLOR_IN_TEXT, parseColor } from "../../color.js";
import { hasTailwind } from "../../config.js";
import { arbitraryValue, tokenizeClasses } from "../classes.js";
import type { FileRule } from "../types.js";

// Utilities tied to the design scale. Layout dimensions (w-[372px], max-w-[720px], grid-cols-[...]) are
// one-off by nature and left alone unless listed in the `prefixes` option.
const SCALE_PREFIX = /^(p[xytrblse]?|m[xytrblse]?|gap(-[xy])?|space-[xy]|rounded(-[a-z]{1,2})?|text|leading|tracking|font|shadow|border(-[xytrblse])?|ring|opacity|z)$/;

export const noArbitraryValue: FileRule = {
  id: "no-arbitrary-value",
  description: "Disallow arbitrary values (p-[13px], text-[15px], rounded-[10px]) for utilities that have a design scale.",
  defaultLevel: "warn",
  runsInUiDir: false,
  enabled: hasTailwind,
  needs: "a Tailwind preset",
  check(ctx) {
    const prefixes = ctx.options.prefixes as string[] | undefined;
    const allow = new Set((ctx.options.allow as string[] | undefined) ?? []);
    const onScale = (prefix: string) => (prefixes ? prefixes.includes(prefix) : SCALE_PREFIX.test(prefix));
    for (const classString of ctx.classStrings) {
      for (const token of tokenizeClasses(classString)) {
        const arbitrary = arbitraryValue(token.utility);
        if (!arbitrary || allow.has(arbitrary.prefix) || !onScale(arbitrary.prefix)) continue;
        // Token references are fine; colors are reported by no-hardcoded-color.
        if (arbitrary.value.includes("var(") || parseColor(arbitrary.value) || COLOR_IN_TEXT.test(arbitrary.value)) continue;
        ctx.report(token.index, `Arbitrary value "${token.raw}" bypasses the design scale.`, "Use a value from the scale, or propose a new token with `designspec propose`.");
      }
    }
  },
};
