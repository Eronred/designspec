import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AtRule, Container, Rule } from "postcss";
import { parseColor } from "../color.js";
import type { Token, TokenType } from "../spec.js";
import { parseStylesheet, stylesheetImports } from "../stylesheets.js";

const VAR_REFERENCE = /^var\(\s*(--[\w-]+)\s*\)$/;
const DIMENSION = /^(-?[\d.]+(px|rem|em|%|vh|vw|ch)|0|calc\(.+\))$/;
const THEME_SELECTOR = /^(:root|html)?((?:\.[\w-]+|\[data-[\w-]+(?:=["']?[\w-]+["']?)?\])*)$/;
const SELECTOR_PART = /\.([\w-]+)|\[data-([\w-]+)(?:=["']?([\w-]+)["']?)?\]/g;

/**
 * Reads CSS custom properties from `:root`, theme selectors (`.dark`, `[data-palette="ocean"]`)
 * and Tailwind v4 `@theme` blocks, following local `@import`s.
 *
 * shadcn on Tailwind v4 defines raw values in `:root` and maps them to utilities in
 * `@theme inline { --color-primary: var(--primary) }`, so `--primary` gets utility `primary`.
 */
export async function extractTokens(root: string, cssFiles: string[], configUtilities = new Map<string, string>()): Promise<Token[]> {
  const base = new Map<string, string>();
  const modes = new Map<string, Map<string, string>>();
  const theme = new Map<string, string>();
  const preprocessor = new Map<string, string>();
  const visited = new Set<string>();

  const collect = async (abs: string): Promise<void> => {
    if (visited.has(abs) || !existsSync(abs)) return;
    visited.add(abs);
    const ast = parseStylesheet(await readFile(abs, "utf8"), abs);

    // Imports come first in the cascade.
    for (const file of stylesheetImports(ast, abs)) await collect(file);

    // Preprocessor variables at the top level: `$primary: #1850ff` (SCSS), `@primary: #1850ff` (Less).
    for (const node of ast.nodes) {
      if (node.type === "decl" && node.prop.startsWith("$")) preprocessor.set(node.prop, node.value.replace(/\s*!default\s*$/, "").trim());
      const lessVariable = node as unknown as { type: string; variable?: boolean; name: string; value?: string };
      if (lessVariable.type === "atrule" && lessVariable.variable && lessVariable.value !== undefined) preprocessor.set(`@${lessVariable.name}`, lessVariable.value.trim());
    }

    ast.walkDecls((decl) => {
      if (!decl.prop.startsWith("--") || !decl.parent) return;
      const value = decl.value.trim();
      const parent = decl.parent;
      if (parent.type === "atrule" && (parent as AtRule).name === "theme") {
        theme.set(decl.prop, value);
        return;
      }
      // Values inside @media/@supports are responsive overrides, not separate tokens.
      if (parent.type !== "rule" || hasConditionalAncestor(parent)) return;
      for (const selector of (parent as Rule).selectors) {
        const mode = themeMode(selector.trim());
        if (mode === "") base.set(decl.prop, value);
        else if (mode) (modes.get(mode) ?? modes.set(mode, new Map()).get(mode)!).set(decl.prop, value);
      }
    });
  };
  for (const file of cssFiles) await collect(path.join(root, file));

  // `--color-primary: var(--primary)` -> utility "primary" for `--primary`. Tailwind v3 configs provide the same mapping.
  const utilityFor = new Map(configUtilities);
  const tokens: Token[] = [];
  const aliases: Array<[string, string]> = [];
  for (const [prop, value] of theme) {
    const ref = VAR_REFERENCE.exec(value)?.[1];
    const utility = themeUtility(prop);
    if (ref && utility) utilityFor.set(ref, utility);
    // `--radius-lg: var(--radius)` is a token of its own (rounded-lg), typed by what it points at.
    else if (ref) aliases.push([prop, ref]);
    else tokens.push(makeToken(prop, value, {}, utility));
  }
  for (const [prop, ref] of aliases) {
    const target = base.get(ref) ?? theme.get(ref);
    tokens.push({ ...makeToken(prop, `var(${ref})`, {}, undefined), type: target ? inferType(target) : "other" });
  }
  // `$link: $primary` resolves to the value it names.
  const resolveVariable = (value: string, depth = 0): string => {
    const ref = preprocessor.get(value);
    return ref !== undefined && depth < 10 ? resolveVariable(ref, depth + 1) : value;
  };
  for (const [name, value] of preprocessor) {
    const resolved = resolveVariable(value);
    tokens.push({ name: name.slice(1), type: inferType(resolved), value: resolved, code: name });
  }
  for (const [prop, value] of base) {
    const tokenModes: Record<string, string> = {};
    for (const [mode, values] of modes) {
      const modeValue = values.get(prop);
      if (modeValue !== undefined && modeValue !== value) tokenModes[mode] = modeValue;
    }
    tokens.push(makeToken(prop, value, tokenModes, utilityFor.get(prop)));
  }
  return tokens;
}

/** `--color-primary` -> `primary` (as in `bg-primary`). Only colors share one suffix across utilities. */
/** Token CSS files plus every local file they `@import`, as project-relative POSIX paths. */
export async function cssImportClosure(root: string, cssFiles: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const visit = async (abs: string): Promise<void> => {
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const ast = parseStylesheet(await readFile(abs, "utf8"), abs);
    for (const file of stylesheetImports(ast, abs)) await visit(file);
  };
  for (const file of cssFiles) await visit(path.join(root, file));
  return [...seen].map((abs) => path.relative(root, abs).split(path.sep).join("/"));
}

function themeUtility(prop: string): string | undefined {
  return /^--color-(.+)$/.exec(prop)?.[1];
}

/**
 * `""` for the base theme, a mode name for theme selectors, `undefined` for anything else.
 * `.dark` -> `dark`, `:root[data-palette="ocean"]` -> `palette=ocean`, `.dark[data-palette="ocean"]` -> `dark+palette=ocean`.
 */
function themeMode(selector: string): string | undefined {
  const match = THEME_SELECTOR.exec(selector);
  if (!match) return undefined;
  const parts: string[] = [];
  for (const part of match[2].matchAll(SELECTOR_PART)) {
    const [, className, attribute, attributeValue] = part;
    if (className) {
      // Bare classes only count as themes for dark/light; `.card { --x }` is component-scoped.
      if (!match[1] && className !== "dark" && className !== "light") return undefined;
      parts.push(className);
    } else if (attribute === "theme" && attributeValue) {
      parts.push(attributeValue);
    } else {
      parts.push(attributeValue ? `${attribute}=${attributeValue}` : attribute);
    }
  }
  if (parts.length === 0) return match[1] ? "" : undefined;
  return parts.join("+");
}

function hasConditionalAncestor(node: Container): boolean {
  for (let parent = node.parent; parent && parent.type !== "root"; parent = parent.parent) {
    if (parent.type === "atrule" && (parent as AtRule).name !== "layer") return true;
  }
  return false;
}

function makeToken(prop: string, value: string, modes: Record<string, string>, utility: string | undefined): Token {
  const type = inferType(value);
  const name = prop.slice(2).replace(/^color-/, "");
  return {
    name,
    type,
    value,
    cssVar: prop,
    ...(utility ? { utility } : {}),
    ...(Object.keys(modes).length ? { modes } : {}),
  };
}

function inferType(value: string): TokenType {
  if (parseColor(value)) return "color";
  if (DIMENSION.test(value)) return "dimension";
  return "other";
}
