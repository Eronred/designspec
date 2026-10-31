import picomatch from "picomatch";
import type { Token } from "../../spec.js";
import { arbitraryValue, tokenizeClasses } from "../classes.js";
import type { FileRule } from "../types.js";

const COLOR_PREFIX = /^(bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|divide|fill|stroke|from|via|to|decoration|placeholder|accent|caret|shadow)-(.+?)(?:\/\S+)?$/;
// Tailwind v4 theme namespaces whose tokens map to one utility: `--radius-card` -> `rounded-card`.
const NAMESPACE_UTILITIES: Array<[RegExp, string]> = [
  [/^rounded-(.+)$/, "radius-"],
  [/^shadow-(.+)$/, "shadow-"],
  [/^text-(.+)$/, "text-"],
  [/^font-(.+)$/, "font-"],
];

export const zoneTokens: FileRule = {
  id: "zone-tokens",
  description: "Keep each zone of the app on its own token set, e.g. marketing tokens out of product UI.",
  defaultLevel: "error",
  runsInUiDir: true,
  enabled: (config) => config.zones.length > 0,
  needs: "zones in the config",
  check(ctx) {
    const zones = ctx.config.zones.filter((z) => picomatch(z.files)(ctx.file) && !(z.ignore?.length && picomatch(z.ignore)(ctx.file)));
    if (zones.length === 0) return;

    const byUtility = new Map<string, Token>();
    const byName = new Map<string, Token>();
    const byCssVar = new Map<string, Token>();
    for (const token of ctx.spec.tokens) {
      if (token.utility) byUtility.set(token.utility, token);
      byName.set(token.name, token);
      if (token.cssVar) byCssVar.set(token.cssVar, token);
    }

    const tokenFor = (utility: string): Token | undefined => {
      const arbitrary = arbitraryValue(utility);
      if (arbitrary) {
        const cssVar = /var\(\s*(--[\w-]+)/.exec(arbitrary.value)?.[1];
        return cssVar ? byCssVar.get(cssVar) : undefined;
      }
      const color = COLOR_PREFIX.exec(utility);
      const fromColor = color && byUtility.get(color[2]);
      if (fromColor) return fromColor;
      for (const [pattern, namespace] of NAMESPACE_UTILITIES) {
        const match = pattern.exec(utility);
        const token = match && byName.get(namespace + match[1]);
        if (token) return token;
      }
      return undefined;
    };

    for (const classString of ctx.classStrings) {
      for (const classToken of tokenizeClasses(classString)) {
        const token = tokenFor(classToken.utility);
        if (!token) continue;
        for (const zone of zones) {
          const denied = zone.denyTokens?.length && picomatch(zone.denyTokens)(token.name);
          const notAllowed = zone.allowTokens?.length && !picomatch(zone.allowTokens)(token.name);
          if (!denied && !notAllowed) continue;
          ctx.report(
            classToken.index,
            `Token "${token.name}" (${classToken.raw}) is not allowed in the ${zone.name} zone.`,
            zone.message ?? (zone.allowTokens?.length ? `Use tokens matching ${zone.allowTokens.join(", ")}.` : `Tokens matching ${zone.denyTokens!.join(", ")} belong to another zone.`),
          );
          break;
        }
      }
    }
  },
};
