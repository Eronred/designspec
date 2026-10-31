import { nearestColorTokenFor } from "../../color.js";
import { hasTailwind } from "../../config.js";
import { TAILWIND_PALETTE } from "../../tailwind-palette.js";
import { walk } from "../../source.js";
import { tokenizeClasses } from "../classes.js";
import { isColorProp } from "./no-hardcoded-color.js";
import type { FileRule } from "../types.js";

const FAMILIES = [...new Set(Object.keys(TAILWIND_PALETTE).map((k) => k.replace(/-\d+$/, "")))].join("|");
const PREFIXES =
  "bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|divide|fill|stroke|from|via|to|decoration|placeholder|accent|caret|shadow|inset-shadow|inset-ring|drop-shadow";
const PALETTE = new RegExp(`^(${PREFIXES})-((?:${FAMILIES})-(?:50|[1-9]00|950))(?:/\\S+)?$`);
// Without an opacity modifier: `bg-black/50` scrims are fine.
const BLACK_WHITE = new RegExp(`^(${PREFIXES})-(white|black)$`);
const CHAKRA_PALETTE = /^(gray|red|orange|yellow|green|teal|blue|cyan|purple|pink)\.(50|[1-9]00|950)$/;
const MANTINE_PALETTE = /^(dark|gray|red|pink|grape|violet|indigo|blue|cyan|teal|green|lime|yellow|orange)\.[0-9]$/;
const BLACK_WHITE_VALUES: Record<string, string> = { white: "#ffffff", black: "#000000" };

export const noPaletteColor: FileRule = {
  id: "no-palette-color",
  description: "Disallow Tailwind's built-in palette colors (bg-red-500), and optionally bare white/black, in favor of semantic tokens.",
  defaultLevel: "error",
  runsInUiDir: false,
  enabled: (config) => hasTailwind(config) || config.presets.includes("chakra") || config.presets.includes("mantine"),
  needs: "Tailwind, Chakra or Mantine",
  check(ctx) {
    const blackWhite = ctx.options.blackWhite === true;
    // Only tokens with a utility can replace a utility class.
    const candidates = ctx.spec.tokens.filter((t) => t.utility);
    // Chakra (bg="red.500") and Mantine (c="blue.6") default palettes, unless the theme defines that color.
    const themeColors = new Set(ctx.spec.tokens.flatMap((t) => (t.utility ? [t.utility] : [])));
    const libraryPalette = [
      ...(ctx.config.presets.includes("chakra") ? [CHAKRA_PALETTE] : []),
      ...(ctx.config.presets.includes("mantine") ? [MANTINE_PALETTE] : []),
    ];
    if (libraryPalette.length) {
      const examples = ctx.spec.tokens.filter((t) => t.type === "color" && t.utility?.includes(".")).slice(0, 3).map((t) => t.utility);
      walk(ctx.ast, (node) => {
        if (node.type !== "JSXAttribute" || node.name.type !== "JSXIdentifier" || !isColorProp(node.name.name, ctx.config)) return;
        const value = node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (value?.type !== "StringLiteral" || themeColors.has(value.value) || !libraryPalette.some((p) => p.test(value.value))) return;
        ctx.report(value.start! + 1, `Default palette color ${node.name.name}="${value.value}".`, `Use a theme color${examples.length ? ` (e.g. ${examples.join(", ")})` : ""}. If none fits, run \`designspec propose\`.`);
      });
    }
    if (!hasTailwind(ctx.config)) return;

    for (const classString of ctx.classStrings) {
      for (const token of tokenizeClasses(classString)) {
        const match = PALETTE.exec(token.utility) ?? (blackWhite ? BLACK_WHITE.exec(token.utility) : null);
        if (!match) continue;
        const [, prefix, color] = match;
        const near = nearestColorTokenFor(prefix, TAILWIND_PALETTE[color] ?? BLACK_WHITE_VALUES[color], candidates);
        ctx.report(
          token.index,
          `Raw palette color "${token.raw}".`,
          near ? `Closest token: ${prefix}-${near.utility}.` : "Use a semantic color token. If none fits, run `designspec propose` to add one.",
        );
      }
    }
  },
};
