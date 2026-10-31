import { differenceCiede2000, formatHex8, parse } from "culori";
import type { Config } from "./config.js";
import type { Spec, Token } from "./spec.js";
import { TAILWIND_THEME } from "./tailwind-palette.js";

/**
 * Figma sync runs through an agent with the Figma MCP server: designspec writes Plugin API scripts,
 * the agent runs them with `use_figma`, and designspec compares the result with the spec. The Plugin API
 * reads and writes variables on every Figma plan (the REST variables API needs Enterprise).
 */

export interface FigmaExport {
  file: string;
  collections: Array<{
    id: string;
    name: string;
    modes: Array<{ id: string; name: string }>;
    variables: Array<{
      id: string;
      name: string;
      type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
      /** WEB code syntax, e.g. `var(--background)`. */
      web: string;
      /** Resolved value per mode name: `#rrggbb[aa]`, a number or a string. */
      values: Record<string, string | number | boolean>;
    }>;
  }>;
  /** Variables in collections the exported variables alias into (primitives), for push-script to reuse. */
  primitives: Array<{ id: string; name: string; collection: string; value: string | number }>;
}

/** What the export script returns: arrays instead of objects, to stay under use_figma's 48 KB result limit. */
interface CompactExport {
  v: 2;
  file: string;
  /** [id, name, modes as [id, name][], variables as [id, name, type, web, values in mode order][]] */
  collections: Array<[string, string, Array<[string, string]>, Array<[string, string, string, string, Array<string | number | boolean>]>]>;
  /** [id, name, collection, value] */
  primitives: Array<[string, string, string, string | number]>;
}

/**
 * Read-only Plugin API script for `use_figma`. Exports variables that have WEB code syntax (the ones that
 * map to code), resolving aliases per mode, plus the primitives they alias. `collections` limits it to some
 * collections, for design systems whose export would exceed use_figma's result limit.
 */
export function exportScript(collections?: string[]): string {
  return `const only = ${JSON.stringify(collections ?? [])};
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const all = await figma.variables.getLocalVariablesAsync();
const byId = new Map(all.map((v) => [v.id, v]));
const colById = new Map(collections.map((c) => [c.id, c]));
const hex = (c) => {
  const h = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b) + (c.a !== undefined && c.a < 0.999 ? h(c.a) : "");
};
const literal = (val) => (val && typeof val === "object" && "r" in val ? hex(val) : val);
// Aliases into the same collection keep the mode; into another collection, use its first mode.
const resolve = (variable, modeId, depth) => {
  const col = colById.get(variable.variableCollectionId);
  const val = variable.valuesByMode[modeId] !== undefined ? variable.valuesByMode[modeId] : variable.valuesByMode[col.modes[0].modeId];
  if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS" && depth < 10) {
    const target = byId.get(val.id);
    if (!target) return null;
    const same = target.variableCollectionId === variable.variableCollectionId;
    return resolve(target, same ? modeId : colById.get(target.variableCollectionId).modes[0].modeId, depth + 1);
  }
  return literal(val);
};
const referenced = new Set();
const out = [];
for (const c of collections) {
  if (only.length && !only.includes(c.name)) continue;
  const vars = c.variableIds.map((id) => byId.get(id)).filter((v) => v && v.codeSyntax && v.codeSyntax.WEB);
  if (vars.length === 0) continue;
  for (const v of vars) for (const m of c.modes) {
    const raw = v.valuesByMode[m.modeId];
    const target = raw && raw.type === "VARIABLE_ALIAS" ? byId.get(raw.id) : null;
    if (target && target.variableCollectionId !== c.id) referenced.add(target.variableCollectionId);
  }
  out.push([c.id, c.name, c.modes.map((m) => [m.modeId, m.name]),
    vars.map((v) => [v.id, v.name, v.resolvedType, v.codeSyntax.WEB, c.modes.map((m) => resolve(v, m.modeId, 0))])]);
}
const primitives = [];
for (const id of referenced) {
  const c = colById.get(id);
  if (!c || out.some((o) => o[0] === id)) continue;
  for (const vid of c.variableIds) {
    const v = byId.get(vid);
    if (v) primitives.push([v.id, v.name, c.name, resolve(v, c.modes[0].modeId, 0)]);
  }
}
return { v: 2, file: figma.root.name, collections: out, primitives };`;
}

/** Reads one or more export results (e.g. one per collection) into one export. */
export function parseExports(raws: unknown[]): FigmaExport {
  const merged: FigmaExport = { file: "", collections: [], primitives: [] };
  for (const raw of raws) {
    const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as CompactExport;
    if (data?.v !== 2 || !Array.isArray(data.collections)) throw new Error("Not a designspec Figma export (run the export script from `designspec figma export-script`).");
    merged.file ||= data.file;
    for (const [id, name, modes, variables] of data.collections) {
      if (merged.collections.some((c) => c.id === id)) continue;
      merged.collections.push({
        id,
        name,
        modes: modes.map(([modeId, modeName]) => ({ id: modeId, name: modeName })),
        variables: variables.map(([vid, vname, type, web, values]) => ({
          id: vid,
          name: vname,
          type: type as FigmaExport["collections"][number]["variables"][number]["type"],
          web,
          values: Object.fromEntries(modes.map(([, modeName], i) => [modeName, values[i]])),
        })),
      });
    }
    for (const [id, name, collection, value] of data.primitives) {
      if (!merged.primitives.some((p) => p.id === id)) merged.primitives.push({ id, name, collection, value });
    }
  }
  return merged;
}

export interface FigmaMismatch {
  cssVar: string;
  figmaName: string;
  collection: string;
  mode: string;
  /** Code mode the Figma mode maps to: `base`, `dark`, `dark+palette=midnight`… */
  codeMode: string;
  figma: string | number | boolean;
  /** The code value as written (may be `var(--border)` or `oklch(...)`). */
  code: string;
  /** The code value resolved to what Figma would store. */
  codeResolved?: string | number;
}

export interface FigmaDiff {
  matches: number;
  mismatches: FigmaMismatch[];
  /** Figma variables whose code syntax names a token the spec doesn't have. */
  onlyInFigma: string[];
  /** Color and dimension tokens no Figma variable points at. */
  onlyInCode: string[];
  /** Variables that can't be compared: derived code syntax (`color-mix(...)`) or relative values (`clamp()`, `em`). */
  unchecked: number;
  /** Figma variables sharing a code syntax with one that matches (e.g. a desktop/mobile pair); informational. */
  alternates: FigmaMismatch[];
  /** How each Figma mode was mapped to code. */
  modeMap: Record<string, Record<string, string>>;
}

const NEUTRAL_WORDS = new Set(["light", "default", "value", "mode", "base", "values"]);
const delta = differenceCiede2000();

function parseColor(value: unknown) {
  try {
    const v = String(value).trim().replace(/^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/, "hsl($1 $2% $3%)");
    return parse(v) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Figma stores 8-bit sRGB: compare after clipping (wide-gamut oklch clips the same way), then perceptually. */
function sameColor(a: unknown, b: unknown): boolean {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return false;
  const hx = formatHex8(x);
  const hy = formatHex8(y);
  return hx === hy || delta(parse(hx)!, parse(hy)!) < 1;
}

function modeParts(key: string): Set<string> {
  return new Set(key.split("+").map((part) => part.split("=").pop()!.toLowerCase()));
}

/**
 * Maps each Figma mode to a code mode by its words: "Midnight Dark" → {midnight, dark} → `dark+palette=midnight`,
 * "Light" / "Value" → base. `config.figma.modes` overrides by mode name.
 */
function mapModes(modeNames: string[], codeModes: string[], overrides: Record<string, string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of modeNames) {
    if (name in overrides) {
      map[name] = overrides[name] || "base";
      continue;
    }
    if (modeNames.length === 1) {
      map[name] = "base";
      continue;
    }
    const words = new Set(name.toLowerCase().split(/[\s_/-]+/).filter((w) => w && !NEUTRAL_WORDS.has(w) && !/^\d+$/.test(w)));
    if (words.size === 0) {
      map[name] = "base";
      continue;
    }
    const match = codeModes.find((key) => {
      const parts = modeParts(key);
      return parts.size === words.size && [...words].every((w) => parts.has(w));
    });
    map[name] = match ?? `?${name}`;
  }
  return map;
}

/** The value a token takes in a code mode, following the CSS cascade: more specific selectors win. */
function codeValueIn(token: Token, codeMode: string, codeModes: string[]): string {
  if (codeMode === "base") return token.value;
  const wanted = modeParts(codeMode);
  const candidates = codeModes
    .filter((key) => [...modeParts(key)].every((p) => wanted.has(p)))
    // More parts = more specific; at equal size `:root[data-x]` (an attribute) beats a bare `.dark` class.
    .sort((a, b) => modeParts(b).size - modeParts(a).size || Number(b.includes("=")) - Number(a.includes("=")));
  for (const key of candidates) if (token.modes && key in token.modes) return token.modes[key];
  return token.value;
}

function lengthPx(value: string, lookup: (cssVar: string) => string | undefined, depth = 0): number | undefined {
  const v = value.trim();
  if (depth > 6) return undefined;
  const plain = /^(-?[\d.]+)(px|rem)?$/.exec(v);
  if (plain) return Number(plain[1]) * (plain[2] === "rem" ? 16 : 1);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) {
    const target = lookup(ref[1]);
    return target === undefined ? undefined : lengthPx(target, lookup, depth + 1);
  }
  // In CSS, + and - need spaces around them (so `var(--radius) - 4px` isn't split inside `--radius`); * doesn't.
  const calc = /^calc\((.+)\s+([+-])\s+(.+)\)$/.exec(v) ?? /^calc\((.+?)\s*(\*)\s*(.+)\)$/.exec(v);
  if (calc) {
    const left = lengthPx(calc[1], lookup, depth + 1);
    const right = lengthPx(calc[3], lookup, depth + 1);
    if (left === undefined || right === undefined) return undefined;
    return calc[2] === "+" ? left + right : calc[2] === "-" ? left - right : left * right;
  }
  return undefined;
}

/** Follows `var(--x)` references to the value that is finally written. */
function lookupChain(value: string, lookup: (cssVar: string) => string | undefined): string {
  let current = value;
  for (let i = 0; i < 6; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(current.trim())?.[1];
    const next = ref && lookup(ref);
    if (!next) break;
    current = next;
  }
  return current;
}

function firstFontFamily(value: string): string {
  // `var(--font-geist-sans, Geist, sans-serif)`: the fallback list is what Figma can name.
  const fallback = /^var\(--[\w-]+,\s*(.+)\)$/.exec(value.trim())?.[1];
  return (fallback ?? value).split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
}

/**
 * Values whose pixel size depends on the viewport or the font size (`clamp()`, `vw`, `em`, unitless line
 * heights) have no single Figma equivalent.
 */
function isRelative(value: string): boolean {
  return /\b(clamp|min|max)\(|\d(vw|vh|svh|dvh|%|em|ch|ex)\b/.test(value) || /^-?\d*\.?\d+$/.test(value.trim());
}

export function figmaDiff(exported: FigmaExport, spec: Spec, config: Config): FigmaDiff {
  const tokens = new Map(spec.tokens.filter((t) => t.cssVar).map((t) => [t.cssVar!, t]));
  // Tailwind's own theme variables (--text-xs, --spacing…) exist without the project defining them.
  if (config.presets.includes("tailwind-v4")) {
    for (const [cssVar, value] of Object.entries(TAILWIND_THEME)) {
      if (!tokens.has(cssVar)) tokens.set(cssVar, { name: cssVar.slice(2), type: "dimension", value, cssVar });
    }
  }
  const codeModes = [...new Set(spec.tokens.flatMap((t) => Object.keys(t.modes ?? {})))];
  const overrides = config.figma?.modes ?? {};
  const result: FigmaDiff = { matches: 0, mismatches: [], onlyInFigma: [], onlyInCode: [], unchecked: 0, alternates: [], modeMap: {} };
  // Several Figma variables can share one code syntax (e.g. a desktop and a mobile size); one matching is enough.
  const matchedKeys = new Set<string>();
  const pending: FigmaMismatch[] = [];
  const seen = new Set<string>();

  for (const collection of exported.collections) {
    if (config.figma?.ignoreCollections?.includes(collection.name)) continue;
    const modeMap = mapModes(collection.modes.map((m) => m.name), codeModes, overrides);
    result.modeMap[collection.name] = modeMap;
    for (const variable of collection.variables) {
      const cssVar = /^var\((--[\w-]+)\)$/.exec(variable.web.trim())?.[1];
      // Derived syntax: compare by evaluating it as a length, else leave unchecked.
      const derivedLength = !cssVar && variable.type === "FLOAT" ? variable.web : undefined;
      if (!cssVar && !derivedLength) {
        result.unchecked++;
        continue;
      }
      const token = cssVar ? tokens.get(cssVar) : undefined;
      if (cssVar) seen.add(cssVar);
      if (cssVar && !token) {
        if (!result.onlyInFigma.includes(cssVar)) result.onlyInFigma.push(cssVar);
        continue;
      }

      for (const mode of collection.modes) {
        const codeMode = modeMap[mode.name];
        if (codeMode.startsWith("?")) continue; // unmapped mode; reported through modeMap
        const lookup = (name: string) => {
          const t = tokens.get(name);
          return t ? codeValueIn(t, codeMode, codeModes) : undefined;
        };
        const code = token ? codeValueIn(token, codeMode, codeModes) : derivedLength!;
        const figmaValue = variable.values[mode.name];
        let resolved: string | number | undefined;
        let same: boolean;
        if (variable.type === "COLOR") {
          let value = code;
          for (let i = 0; i < 6; i++) {
            const ref = /^var\((--[\w-]+)\)$/.exec(value.trim())?.[1];
            const next = ref && lookup(ref);
            if (!next) break;
            value = next;
          }
          const color = parseColor(value);
          resolved = color ? formatHex8(color).replace(/ff$/, "") : value;
          same = sameColor(value, figmaValue);
        } else if (variable.type === "FLOAT") {
          resolved = lengthPx(code, lookup) ?? (Number.isFinite(Number(code)) ? Number(code) : undefined);
          same = typeof resolved === "number" && typeof figmaValue === "number" && Math.abs(resolved - figmaValue) < 0.01;
          // Unresolvable or relative (clamp, em, unitless line height): not comparable to Figma pixels.
          if (!same && (resolved === undefined || isRelative(lookupChain(code, lookup)))) {
            result.unchecked++;
            continue;
          }
        } else {
          resolved = code;
          same = firstFontFamily(String(code)) === firstFontFamily(String(figmaValue));
        }
        const key = `${cssVar ?? variable.web}|${mode.name}`;
        if (same) {
          result.matches++;
          matchedKeys.add(key);
        } else {
          pending.push({ cssVar: cssVar ?? variable.web, figmaName: variable.name, collection: collection.name, mode: mode.name, codeMode, figma: figmaValue, code, codeResolved: resolved });
        }
      }
    }
  }
  for (const m of pending) {
    if (matchedKeys.has(`${m.cssVar}|${m.mode}`)) result.alternates.push(m);
    else result.mismatches.push(m);
  }
  for (const [cssVar, token] of tokens) {
    if (seen.has(cssVar) || (token.type !== "color" && token.type !== "dimension") || !spec.tokens.includes(token)) continue;
    // Tailwind companions (--text-xs--line-height) and aliases of tokens Figma has aren't separate tokens.
    if (/^--.+--/.test(cssVar)) continue;
    const target = /^var\((--[\w-]+)\)$/.exec(token.value.trim())?.[1];
    if (target && seen.has(target)) continue;
    result.onlyInCode.push(cssVar);
  }
  return result;
}

interface PushStep {
  variableId: string;
  modeId: string;
  label: string;
  aliasId?: string;
  value?: string | number;
}

/**
 * A Plugin API script that writes code values into Figma for the given mismatches. It keeps Figma's structure:
 * a code alias (`var(--border)`) becomes an alias to that variable, and a literal reuses a primitive with the
 * same value before writing a raw value.
 */
export function figmaPushScript(exported: FigmaExport, diff: FigmaDiff, only?: string[]): { script: string; steps: PushStep[] } {
  const byWeb = new Map<string, { id: string; collection: string }>();
  for (const c of exported.collections) for (const v of c.variables) byWeb.set(v.web.trim(), { id: v.id, collection: c.name });
  const steps: PushStep[] = [];
  for (const m of diff.mismatches) {
    if (only?.length && !only.includes(m.cssVar)) continue;
    const collection = exported.collections.find((c) => c.name === m.collection)!;
    const variable = collection.variables.find((v) => v.name === m.figmaName)!;
    const modeId = collection.modes.find((mode) => mode.name === m.mode)!.id;
    const label = `${m.figmaName} [${m.mode}]`;
    const ref = /^var\((--[\w-]+)\)$/.exec(m.code.trim())?.[1];
    const sameCollectionTarget = ref ? byWeb.get(`var(${ref})`) : undefined;
    if (sameCollectionTarget && sameCollectionTarget.collection === m.collection) {
      steps.push({ variableId: variable.id, modeId, label: `${label} → alias ${ref}`, aliasId: sameCollectionTarget.id });
      continue;
    }
    if (variable.type === "COLOR" && typeof m.codeResolved === "string") {
      const primitive = exported.primitives.find((p) => typeof p.value === "string" && sameColor(p.value, m.codeResolved));
      if (primitive) steps.push({ variableId: variable.id, modeId, label: `${label} → alias ${primitive.collection}/${primitive.name}`, aliasId: primitive.id });
      else steps.push({ variableId: variable.id, modeId, label: `${label} → ${m.codeResolved}`, value: m.codeResolved });
    } else if (m.codeResolved !== undefined) {
      steps.push({ variableId: variable.id, modeId, label: `${label} → ${m.codeResolved}`, value: m.codeResolved });
    }
  }
  const script = `// designspec figma push: ${steps.length} change(s)
const steps = ${JSON.stringify(steps)};
const toColor = (hex) => {
  const n = hex.replace("#", "");
  const c = (i) => parseInt(n.slice(i, i + 2), 16) / 255;
  return { r: c(0), g: c(2), b: c(4), a: n.length === 8 ? c(6) : 1 };
};
const done = [];
for (const step of steps) {
  const variable = await figma.variables.getVariableByIdAsync(step.variableId);
  if (!variable) throw new Error("Variable not found: " + step.variableId);
  if (step.aliasId) {
    const target = await figma.variables.getVariableByIdAsync(step.aliasId);
    if (!target) throw new Error("Alias target not found: " + step.aliasId);
    variable.setValueForMode(step.modeId, figma.variables.createVariableAlias(target));
  } else {
    variable.setValueForMode(step.modeId, variable.resolvedType === "COLOR" ? toColor(String(step.value)) : step.value);
  }
  done.push(step.label);
}
return { mutatedVariableIds: [...new Set(steps.map((s) => s.variableId))], changes: done };`;
  return { script, steps };
}
