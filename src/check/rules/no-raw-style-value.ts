import { isReactNative } from "../../config.js";
import type { Token } from "../../spec.js";
import { collectStyleProperties, numericValue } from "../styles.js";
import type { FileRule } from "../types.js";

export const SCALE_KEYS: Record<string, RegExp> = {
  spacing: /^(padding|margin)(Horizontal|Vertical|Top|Bottom|Left|Right|Start|End|Inline|Block)?$|^(gap|rowGap|columnGap)$/,
  radius: /^border(TopLeft|TopRight|BottomLeft|BottomRight|TopStart|TopEnd|BottomStart|BottomEnd)?Radius$/,
};

/** Token groups (first segment of `token.code`) that hold each scale. */
export const DEFAULT_SCALES: Record<string, string[]> = {
  spacing: ["spacing", "space"],
  radius: ["radius", "radii"],
};

export const noRawStyleValue: FileRule = {
  id: "no-raw-style-value",
  description: "In React Native styles, use spacing/radius tokens (spacing.md) instead of raw numbers (padding: 16).",
  defaultLevel: "warn",
  runsInUiDir: false,
  idleReason: (spec) =>
    spec.tokens.some((t) => t.code && /^(spacing|space|radius|radii)\./.test(t.code)) ? undefined : "no spacing or radius tokens in the theme",
  enabled: isReactNative,
  needs: "the react-native preset",
  check(ctx) {
    const scales = { ...DEFAULT_SCALES, ...((ctx.options.scales as Record<string, string[]> | undefined) ?? {}) };
    const allow = new Set((ctx.options.allow as number[] | undefined) ?? [0]);
    const tokensByScale = new Map<string, Token[]>();
    for (const [scale, groups] of Object.entries(scales)) {
      const tokens = ctx.spec.tokens.filter((t) => t.code && groups.includes(t.code.split(".")[0]) && t.code.split(".").length === 2);
      if (tokens.length) tokensByScale.set(scale, tokens);
    }
    if (tokensByScale.size === 0) return;

    for (const { key, value } of collectStyleProperties(ctx.ast)) {
      const scale = Object.keys(SCALE_KEYS).find((s) => SCALE_KEYS[s].test(key));
      const tokens = scale && tokensByScale.get(scale);
      const n = numericValue(value);
      if (!tokens || n === undefined || allow.has(n)) continue;
      const match = tokens.find((t) => Number(t.value) === Math.abs(n));
      if (match) {
        ctx.report(value.start!, `Raw ${scale} value "${key}: ${n}".`, `Use ${n < 0 ? "-" : ""}${match.code}.`);
      } else {
        const values = [...new Set(tokens.map((t) => Number(t.value)))].sort((a, b) => a - b).join(", ");
        ctx.report(value.start!, `"${key}: ${n}" is not on the ${scale} scale.`, `Use a ${scale} token (${values}), or propose a new one with \`designspec propose\`.`);
      }
    }
  },
};
