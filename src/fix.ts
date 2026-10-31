import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImportDeclaration, JSXAttribute, JSXOpeningElement } from "@babel/types";
import { formatHex8 } from "culori";
import { arbitraryValue, classStringsIn, collectClassStrings, tokenizeClasses, utilityFamily } from "./check/classes.js";
import { resolveFiles } from "./check/index.js";
import { collectImports, resolveComponent } from "./check/imports.js";
import { parseColor } from "./color.js";
import { DEFAULT_SCALES, SCALE_KEYS } from "./check/rules/no-raw-style-value.js";
import { collectStyleProperties, numericValue } from "./check/styles.js";
import { type Config, hasTailwind, isReactNative, loadConfig, ruleSetting } from "./config.js";
import { importSpecifier } from "./detect.js";
import { extractSpec } from "./extract/index.js";
import { parseCode, SourceText, walk } from "./source.js";
import type { Spec, Token } from "./spec.js";
import { allowedInZones } from "./zones.js";

export interface FileFix {
  file: string;
  /** Human-readable changes, e.g. `12: <Panel> px-3 py-2 → padding="compact"`. */
  changes: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Rewrites code into the design system where that is safe to do automatically:
 *
 * - className overrides that exactly match a variant become that variant:
 *   `<Panel padding="none" className="px-3 py-2">` → `<Panel padding="compact">`.
 * - Arbitrary colors equal to a token become the token utility: `text-[#1a1a1a]` → `text-foreground`.
 *   Tokens with other theme modes (dark) are only used with `colors: true`, since the color then adapts.
 *
 * Everything else is left for a person, so the default run never changes how the UI looks.
 */
export async function runFix(root: string, options: { paths?: string[]; dryRun?: boolean; colors?: boolean }): Promise<FileFix[]> {
  const config = await loadConfig(root);
  // Fresh from code: option classes are not stored in the spec.
  const spec = await extractSpec(root, config);
  const fixes: FileFix[] = [];

  for (const file of await resolveFiles(root, config, options.paths, undefined)) {
    if (file.startsWith(`${config.uiDir}/`) || /\.(css|scss|less)$/.test(file)) continue;
    const original = await readFile(path.join(root, file), "utf8");
    // Separate passes: both can touch the same class string.
    const variants = fixVariants(file, original, config, spec);
    const colors = fixColors(file, variants.text, config, spec, options.colors === true);
    const styles = await fixStyleValues(root, file, colors.text, config, spec);
    const changes = [...variants.changes, ...colors.changes, ...styles.changes];
    if (changes.length === 0) continue;
    fixes.push({ file, changes });
    if (!options.dryRun) await writeFile(path.join(root, file), styles.text);
  }
  return fixes;
}

function fixVariants(file: string, text: string, config: Config, spec: Spec): { text: string; changes: string[] } {
  let ast: ReturnType<typeof parseCode>;
  try {
    ast = parseCode(text, file);
  } catch {
    return { text, changes: [] };
  }
  const source = new SourceText(text);
  const imports = collectImports(ast);
  const edits: Edit[] = [];
  const changes: string[] = [];

  walk(ast, (node) => {
    if (node.type !== "JSXOpeningElement" || node.name.type !== "JSXIdentifier") return;
    const local = node.name.name;
    const binding = imports.find((b) => b.local === local);
    const component = binding && resolveComponent(binding, file, config, spec);
    const controls = component && binding && component.controls[binding.imported];
    const optionClasses = component && binding && component.optionClasses?.[binding.imported];
    if (!controls || !optionClasses) return;
    const className = attribute(node, "className");
    if (!className) return;

    const classStrings = classStringsIn(className.value, text);
    const removed = new Set<number>();
    const elementEdits: Edit[] = [];
    // New props go where className is, since they take over from it.
    const newProps: string[] = [];
    const elementChanges: string[] = [];

    for (const [prop, families] of Object.entries(controls)) {
      const overrides = classStrings.flatMap((s) => tokenizeClasses(s)).filter((t) => families.includes(utilityFamily(t.utility) ?? ""));
      // Responsive or state-prefixed overrides (md:px-6) have no variant equivalent.
      if (overrides.length === 0 || overrides.some((t) => t.raw !== t.utility)) continue;
      const wanted = new Set(overrides.map((t) => t.raw));
      const existing = attribute(node, prop);
      if (existing && existing.value?.type !== "StringLiteral") continue;
      const inFamilies = (c: string) => families.includes(utilityFamily(c) ?? "");
      const current = existing?.value?.type === "StringLiteral" ? existing.value.value : component.defaults[binding.imported]?.[prop];
      const currentClasses = (current !== undefined ? optionClasses[prop]?.[current] : undefined) ?? [];
      // The override must fully replace what the current option sets in these families...
      if (!currentClasses.filter(inFamilies).every((c) => covered(c, [...wanted]))) continue;
      const option = Object.entries(optionClasses[prop] ?? {}).find(([, classes]) => {
        const relevant = classes.filter(inFamilies);
        // ...and the new option must not bring other styles along (e.g. a "line" variant's border).
        return relevant.length === wanted.size && relevant.every((c) => wanted.has(c)) && sameSet(classes.filter((c) => !inFamilies(c)), currentClasses.filter((c) => !inFamilies(c)));
      })?.[0];
      if (!option) continue;

      if (existing?.value?.type === "StringLiteral") {
        elementEdits.push({ start: existing.value.start! + 1, end: existing.value.end! - 1, text: option });
      } else {
        newProps.push(`${prop}="${option}"`);
      }
      for (const t of overrides) removed.add(t.index);
      elementChanges.push(`${[...wanted].join(" ")} → ${prop}="${option}"`);
    }
    if (elementChanges.length === 0) return;

    for (const classString of classStrings) {
      const tokens = tokenizeClasses(classString);
      if (!tokens.some((t) => removed.has(t.index))) continue;
      const remaining = tokens.filter((t) => !removed.has(t.index)).map((t) => t.raw);
      if (remaining.length === 0 && className.value?.type === "StringLiteral") {
        // `className="px-3 py-2"` is now empty: replace it with the new props, or drop it with the space before it.
        const start = newProps.length === 0 && /\s/.test(text[className.start! - 1]) ? className.start! - 1 : className.start!;
        elementEdits.push({ start, end: className.end!, text: newProps.join(" ") });
        newProps.length = 0;
      } else if (remaining.length === 0) {
        elementEdits.push(dropArgument(text, classString.start, classString.start + classString.text.length));
      } else {
        elementEdits.push({ start: classString.start, end: classString.start + classString.text.length, text: remaining.join(" ") });
      }
    }
    if (newProps.length) elementEdits.push({ start: className.start!, end: className.start!, text: `${newProps.join(" ")} ` });
    edits.push(...elementEdits);
    changes.push(`${source.position(node.start!).line}: <${local}> ${elementChanges.join(", ")}`);
  });

  return { text: applyEdits(text, edits), changes };
}

const OPACITY = /\](\/\S+)$/;

function fixColors(file: string, text: string, config: Config, spec: Spec, includeThemed: boolean): { text: string; changes: string[] } {
  if (!hasTailwind(config)) return { text, changes: [] };
  let ast: ReturnType<typeof parseCode>;
  try {
    ast = parseCode(text, file);
  } catch {
    return { text, changes: [] };
  }
  const source = new SourceText(text);
  const candidates = spec.tokens.filter((t) => t.type === "color" && t.utility && (includeThemed || !t.modes || Object.keys(t.modes).length === 0) && allowedInZones(t, file, config));
  const byHex = new Map<string, Token>();
  for (const token of candidates) {
    const hex = hex8(token.value);
    if (hex && !byHex.has(hex)) byHex.set(hex, token);
  }
  const edits: Edit[] = [];
  const changes: string[] = [];
  for (const classString of collectClassStrings(ast, text, config.classFunctions)) {
    for (const t of tokenizeClasses(classString)) {
      const arbitrary = arbitraryValue(t.utility);
      if (!arbitrary || arbitrary.prefix.startsWith("[")) continue;
      const hex = hex8(arbitrary.value);
      const token = hex && byHex.get(hex);
      if (!token) continue;
      const replacement = `${arbitrary.prefix}-${token.utility}${OPACITY.exec(t.utility)?.[1] ?? ""}`;
      const at = t.raw.indexOf(t.utility);
      edits.push({ start: t.index + at, end: t.index + at + t.utility.length, text: replacement });
      changes.push(`${source.position(t.index).line}: ${t.utility} → ${replacement}${token.modes ? " (adapts to dark mode)" : ""}`);
    }
  }
  return { text: applyEdits(text, edits), changes };
}

/**
 * React Native: raw numbers equal to a spacing/radius token become the token (`padding: 16` → `spacing.md`),
 * importing the token group from the theme when the file doesn't have it yet. Off-scale values are left alone.
 */
async function fixStyleValues(root: string, file: string, text: string, config: Config, spec: Spec): Promise<{ text: string; changes: string[] }> {
  const none = { text, changes: [] };
  if (!isReactNative(config)) return none;
  const { level, options } = ruleSetting(config, "no-raw-style-value", "warn");
  if (level === "off") return none;
  let ast: ReturnType<typeof parseCode>;
  try {
    ast = parseCode(text, file);
  } catch {
    return none;
  }
  const scales = { ...DEFAULT_SCALES, ...((options.scales as Record<string, string[]> | undefined) ?? {}) };
  const allow = new Set((options.allow as number[] | undefined) ?? [0]);
  const source = new SourceText(text);
  const edits: Edit[] = [];
  const changes: string[] = [];
  const needed = new Map<string, Token>();

  for (const { key, value } of collectStyleProperties(ast)) {
    const scale = Object.keys(SCALE_KEYS).find((s) => SCALE_KEYS[s].test(key));
    const n = numericValue(value);
    if (!scale || n === undefined || allow.has(n)) continue;
    const token = spec.tokens.find((t) => t.code?.split(".").length === 2 && scales[scale]?.includes(t.code.split(".")[0]) && Number(t.value) === Math.abs(n));
    if (!token?.code) continue;
    const replacement = `${n < 0 ? "-" : ""}${token.code}`;
    edits.push({ start: value.start!, end: value.end!, text: replacement });
    changes.push(`${source.position(value.start!).line}: ${key}: ${n} → ${replacement}`);
    needed.set(token.code.split(".")[0], token);
  }
  if (edits.length === 0) return none;

  const imports = ast.program.body.filter((s): s is ImportDeclaration => s.type === "ImportDeclaration");
  const first = imports[0];
  const quote = first ? text[first.source.start!] : '"';
  const semi = first && text[first.end! - 1] === ";" ? ";" : "";
  for (const [group, token] of needed) {
    if (imports.some((d) => d.specifiers.some((s) => s.local.name === group))) continue;
    if (!token.source) return none; // can't import it safely; leave the file as is
    const specifier = await importSpecifier(root, file, await themeEntry(root, token.source, group));
    const existing = imports.find((d) => d.source.value === specifier && d.importKind !== "type" && d.specifiers.at(-1)?.type === "ImportSpecifier");
    if (existing) {
      edits.push({ start: existing.specifiers.at(-1)!.end!, end: existing.specifiers.at(-1)!.end!, text: `, ${group}` });
    } else {
      const statement = `import { ${group} } from ${quote}${specifier}${quote}${semi}`;
      const last = imports.at(-1);
      edits.push(last ? { start: last.end!, end: last.end!, text: `\n${statement}` } : { start: 0, end: 0, text: `${statement}\n` });
    }
  }
  return { text: applyEdits(text, edits), changes };
}

/** The module to import a token group from: the folder's index when it re-exports the group, else the file itself. */
async function themeEntry(root: string, source: string, group: string): Promise<string> {
  for (const index of ["index.ts", "index.tsx", "index.js"]) {
    const candidate = path.posix.join(path.posix.dirname(source), index);
    if (!existsSync(path.join(root, candidate))) continue;
    const code = await readFile(path.join(root, candidate), "utf8");
    if (new RegExp(`\\b${group}\\b|export \\*`).test(code)) return candidate;
  }
  return source;
}

function hex8(value: string): string | undefined {
  const color = parseColor(value);
  return color ? formatHex8(color) : undefined;
}

const PADDING_AXES: Record<string, string[]> = { p: ["t", "r", "b", "l"], px: ["r", "l"], py: ["t", "b"], pt: ["t"], pr: ["r"], pb: ["b"], pl: ["l"], ps: ["l"], pe: ["r"] };
const CORNER_AXES: Record<string, string[]> = { "": ["tl", "tr", "bl", "br"], t: ["tl", "tr"], b: ["bl", "br"], l: ["tl", "bl"], r: ["tr", "br"], s: ["tl", "bl"], e: ["tr", "br"], tl: ["tl"], tr: ["tr"], bl: ["bl"], br: ["br"] };

/** The box sides/corners a class sets, so `p-4` counts as replaced by `px-3 py-2`. */
function axes(cls: string): string[] {
  const padding = /^(p[xytrblse]?)-/.exec(cls);
  if (padding) return PADDING_AXES[padding[1]].map((a) => `p${a}`);
  const radius = /^rounded(?:-(tl|tr|bl|br|[tblrse]))?(?:-|$)/.exec(cls);
  if (radius) return CORNER_AXES[radius[1] ?? ""].map((a) => `r${a}`);
  if (cls.startsWith("size-")) return ["h", "w"];
  const height = /^(h|min-h|max-h)-/.exec(cls);
  return [height ? height[1] : cls];
}

function covered(cls: string, overrides: string[]): boolean {
  const covering = new Set(overrides.flatMap(axes));
  return axes(cls).every((a) => covering.has(a));
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Removes an emptied string argument with its comma: `cn("px-3", x)` → `cn(x)`; falls back to `""`. */
function dropArgument(text: string, contentStart: number, contentEnd: number): Edit {
  const quote = text[contentStart - 1];
  if ((quote === '"' || quote === "'" || quote === "`") && text[contentEnd] === quote) {
    const after = /^\s*,\s*/.exec(text.slice(contentEnd + 1));
    if (after) return { start: contentStart - 1, end: contentEnd + 1 + after[0].length, text: "" };
    const before = /,\s*$/.exec(text.slice(0, contentStart - 1));
    if (before) return { start: contentStart - 1 - before[0].length, end: contentEnd + 1, text: "" };
  }
  return { start: contentStart, end: contentEnd, text: "" };
}

function attribute(node: JSXOpeningElement, name: string): JSXAttribute | undefined {
  return node.attributes.find((a): a is JSXAttribute => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name);
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  let lastStart = Infinity;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.end > lastStart) continue; // overlapping edit; the outer one already covers it
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}
