import type { Declaration, Root } from "postcss";
import { parseStylesheet } from "../stylesheets.js";
import { nearestColorToken, parseColor } from "../color.js";
import { type Config, ruleSetting } from "../config.js";
import type { Spec } from "../spec.js";
import { tokenReferenceChecker, VAR_REFERENCE } from "./token-refs.js";
import type { Violation } from "./types.js";
import { SourceText } from "../source.js";
import picomatch from "picomatch";

const COLOR_PROPERTY = /color|background|fill|stroke|border|outline|shadow/i;
const KEYWORDS = /^(transparent|currentcolor|inherit|initial|unset|none)$/i;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(([^)]*)\)/i;

/**
 * A literal color in a value. `rgba($black, .5)`, `rgb(var(--x) / 50%)` and Less `fade(@primary, 10%)` use
 * tokens, so a color function counts only when its arguments are literal.
 */
function colorLiteral(value: string): string | undefined {
  const hex = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/i.exec(value)?.[0];
  if (hex) return hex;
  const fn = COLOR_FUNCTION.exec(value);
  return fn && !/[$@]|var\(/.test(fn[1]) ? fn[0] : undefined;
}

export interface EmbeddedCss {
  /** The file the CSS is embedded in. */
  source: SourceText;
  /** Maps an index in the CSS text to an index in the file. */
  toSource(index: number): number;
  /** Skip hardcoded colors (inside the design system's own UI directory). */
  skipColors?: boolean;
  /** The stylesheet language, when it isn't the file's (a <style lang="scss"> block). */
  lang?: "css" | "scss" | "less";
}

/**
 * Rules for stylesheets outside the token sources: hardcoded colors and unknown var() references.
 * `embedded` checks CSS inside another file (a styled-components template) and reports at file positions.
 */
export function checkCss(file: string, text: string, config: Config, spec: Spec, definedVars: Set<string>, embedded?: EmbeddedCss): Violation[] {
  const source = embedded?.source ?? new SourceText(text);
  const toSource = embedded?.toSource ?? ((index: number) => index);
  let root: Root;
  try {
    root = parseStylesheet(text, embedded?.lang ? `embedded.${embedded.lang}` : file);
  } catch (error) {
    // Templates with interpolated selectors or mixins may not parse; the file itself is still checked.
    if (embedded) return [];
    const e = error as { line?: number; column?: number; reason?: string };
    return [{ rule: "parse-error", severity: "warn", file, line: e.line ?? 1, column: e.column ?? 1, message: `Could not parse file: ${e.reason ?? (error as Error).message}` }];
  }

  const violations: Violation[] = [];
  const active = (id: string, fallback: "error" | "warn") => {
    const { level, options } = ruleSetting(config, id, fallback);
    const ignore = options.ignore as string[] | undefined;
    if (level === "off" || (ignore?.length && picomatch(ignore)(file))) return undefined;
    return { level, options };
  };
  const report = (rule: string, severity: "error" | "warn", index: number, message: string, suggestion?: string) => {
    const { line, column } = source.position(toSource(index));
    violations.push({ rule, severity, file, line, column, message, suggestion });
  };
  const valueIndex = (decl: Declaration) => {
    const start = decl.source?.start?.offset ?? 0;
    const at = text.indexOf(decl.value, start + decl.prop.length);
    return at >= 0 ? at : start;
  };

  const colorRule = embedded?.skipColors ? undefined : active("no-hardcoded-color", "error");
  const tokenRule = active("no-unknown-token", "warn");
  const exists = tokenReferenceChecker(config, spec, (tokenRule?.options.allow as string[] | undefined) ?? []);

  root.walkDecls((decl) => {
    const value = decl.value.trim();
    if (colorRule && !KEYWORDS.test(value)) {
      const color = colorLiteral(value) ?? (COLOR_PROPERTY.test(decl.prop) && /^[a-z]+$/i.test(value) && parseColor(value) ? value : undefined);
      if (color) {
        // In SCSS / Less, prefer that language's own variables ($brand, @surface) over CSS custom properties.
        const language = embedded?.lang ?? /\.(scss|less)$/.exec(file)?.[1];
        const sigil = language === "scss" ? "$" : language === "less" ? "@" : undefined;
        const own = sigil ? spec.tokens.filter((t) => t.code?.startsWith(sigil)) : [];
        const near = nearestColorToken(color, own) ?? nearestColorToken(color, spec.tokens);
        const reference = near?.code ?? (near?.cssVar ? `var(${near.cssVar})` : undefined);
        report("no-hardcoded-color", colorRule.level as "error" | "warn", valueIndex(decl), `Hardcoded color ${decl.prop}: ${value}.`, reference ? `Closest token: ${reference}.` : "Use a color token. If none fits, run `designspec propose` to add one.");
      }
    }
    if (tokenRule) {
      for (const match of decl.value.matchAll(VAR_REFERENCE)) {
        if (exists(match[1], definedVars)) continue;
        report("no-unknown-token", tokenRule.level as "error" | "warn", valueIndex(decl) + match.index!, `Unknown token ${match[1]}.`, "Check the name against design/tokens.json, or define the token first (`designspec propose`).");
      }
    }
  });
  return violations;
}
