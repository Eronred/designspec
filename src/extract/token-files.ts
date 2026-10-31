import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseColor } from "../color.js";
import type { Token, TokenType } from "../spec.js";

/** A token file: a DTCG / Tokens Studio JSON file, optionally one mode of a theme or one set of a Tokens Studio file. */
export type TokenFileEntry = string | { path: string; mode?: string; set?: string };

interface RawToken {
  path: string[];
  type?: string;
  value: unknown;
}

const CSS_COLOR_SPACES: Record<string, (c: string[], alpha: string) => string> = {
  hsl: ([h, s, l], a) => `hsl(${h} ${s}% ${l}% / ${a})`,
  hwb: ([h, w, b], a) => `hwb(${h} ${w}% ${b}% / ${a})`,
  lab: ([l, a, b], alpha) => `lab(${l}% ${a} ${b} / ${alpha})`,
  lch: ([l, c, h], a) => `lch(${l}% ${c} ${h} / ${a})`,
  oklab: ([l, a, b], alpha) => `oklab(${l} ${a} ${b} / ${alpha})`,
  oklch: ([l, c, h], a) => `oklch(${l} ${c} ${h} / ${a})`,
};

/**
 * Reads tokens from W3C DTCG files (`$value`, `$type`, group `$type` inheritance, `{group.token}` aliases,
 * 2025 color and dimension objects) and Tokens Studio files (`value` / `type`). Each token maps to the CSS
 * variable Style Dictionary would generate: `color.bg.primary` → `--color-bg-primary`.
 */
export async function extractTokenFiles(root: string, entries: TokenFileEntry[]): Promise<Token[]> {
  const base = new Map<string, RawToken>();
  const modes = new Map<string, Map<string, RawToken>>();

  for (const entry of entries) {
    const { path: file, mode, set } = typeof entry === "string" ? { path: entry, mode: undefined, set: undefined } : entry;
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    let json = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
    if (set) json = (json[set] as Record<string, unknown>) ?? {};
    const target = mode ? (modes.get(mode) ?? modes.set(mode, new Map()).get(mode)!) : base;
    for (const token of collect(json, [], undefined)) target.set(token.path.join("."), token);
  }

  const resolve = (value: unknown, scope: Map<string, RawToken>, depth = 0): unknown => {
    if (typeof value !== "string" || depth > 10) return value;
    const ref = /^\{([^}]+)\}$/.exec(value.trim())?.[1];
    if (!ref) return value;
    const target = scope.get(ref) ?? base.get(ref);
    return target ? resolve(target.value, scope, depth + 1) : value;
  };

  const tokens: Token[] = [];
  for (const [key, raw] of base) {
    const value = toCss(resolve(raw.value, base), raw.type);
    if (value === undefined) continue;
    const tokenModes: Record<string, string> = {};
    for (const [mode, overrides] of modes) {
      const override = overrides.get(key);
      const modeValue = override ? toCss(resolve(override.value, overrides), override.type ?? raw.type) : undefined;
      if (modeValue !== undefined && modeValue !== value) tokenModes[mode] = modeValue;
    }
    tokens.push({
      name: raw.path.join("-"),
      type: tokenType(raw.type, value),
      value,
      cssVar: `--${raw.path.join("-")}`,
      ...(Object.keys(tokenModes).length ? { modes: tokenModes } : {}),
    });
  }
  return tokens;
}

function* collect(node: Record<string, unknown>, pathParts: string[], inheritedType: string | undefined): Generator<RawToken> {
  const groupType = (node.$type as string | undefined) ?? inheritedType;
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$") || child === null || typeof child !== "object") continue;
    const record = child as Record<string, unknown>;
    if ("$value" in record) {
      yield { path: [...pathParts, key], type: (record.$type as string | undefined) ?? groupType, value: record.$value };
    } else if ("value" in record && "type" in record) {
      // Tokens Studio: { value, type } without the $ prefix.
      yield { path: [...pathParts, key], type: (record.type as string | undefined) ?? groupType, value: record.value };
    } else {
      yield* collect(record, [...pathParts, key], groupType);
    }
  }
}

/** A token value as CSS, or undefined for values with no CSS equivalent (composites). */
function toCss(value: unknown, type: string | undefined): string | undefined {
  if (typeof value === "number") return type === "dimension" ? `${value}px` : String(value);
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // DTCG 2025 dimension: { value: 16, unit: "px" }
  if (typeof record.value === "number" && typeof record.unit === "string") return `${record.value}${record.unit}`;
  // DTCG 2025 color: { colorSpace, components, alpha?, hex? }
  if (typeof record.colorSpace === "string" && Array.isArray(record.components)) {
    const components = record.components.map((c) => (c === "none" ? "none" : String(c)));
    const alpha = typeof record.alpha === "number" ? String(record.alpha) : "1";
    const css = CSS_COLOR_SPACES[record.colorSpace];
    if (css) return css(components, alpha);
    return `color(${record.colorSpace} ${components.join(" ")} / ${alpha})`;
  }
  return undefined;
}

function tokenType(type: string | undefined, value: string): TokenType {
  if (type === "color" || (!type && parseColor(value))) return "color";
  if (type === "dimension" || type === "spacing" || type === "borderRadius" || type === "sizing" || type === "fontSizes") return "dimension";
  return parseColor(value) ? "color" : "other";
}
