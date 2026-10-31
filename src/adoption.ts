import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectClassStrings, tokenizeClasses } from "./check/classes.js";
import { projectContext, resolveFiles, runCheck } from "./check/index.js";
import { collectImports, resolveComponent } from "./check/imports.js";
import { parseSfc } from "./check/sfc.js";
import type { Violation } from "./check/types.js";
import { VAR_REFERENCE } from "./check/token-refs.js";
import type { Config } from "./config.js";
import { parseCode, walk } from "./source.js";
import type { Spec } from "./spec.js";
import { STYLESHEET } from "./stylesheets.js";

export interface Adoption {
  /** Design system components used, and native elements / primitives used where one exists. */
  components: { ds: number; bypassed: number };
  /** Colors through tokens, and hardcoded or palette colors. */
  colors: { tokens: number; bypassed: number };
  /** 0–100, or undefined when there's nothing to measure. */
  componentScore?: number;
  colorScore?: number;
  score?: number;
}

const COLOR_UTILITY = /^(bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|divide|fill|stroke|from|via|to|decoration|placeholder|accent|caret|shadow)-(.+?)(?:\/\S+)?$/;

/**
 * How much of the UI goes through the design system: components over the native elements they replace, and
 * token colors over hardcoded and palette ones. Counted over the whole project, baselined problems included.
 */
export async function measureAdoption(root: string, config: Config, spec: Spec, known?: Violation[]): Promise<Adoption> {
  const violations = known ?? (await runCheck({ root, useBaseline: false })).violations;
  const bypassedComponents = violations.filter((v) => v.rule === "prefer-ds-component").length;
  const bypassedColors = violations.filter((v) => v.rule === "no-hardcoded-color" || v.rule === "no-palette-color").length;

  const colorTokens = spec.tokens.filter((t) => t.type === "color");
  const utilities = new Set(colorTokens.flatMap((t) => (t.utility ? [t.utility] : [])));
  const cssVars = new Set(colorTokens.flatMap((t) => (t.cssVar ? [t.cssVar] : [])));
  const codes = new Set(colorTokens.flatMap((t) => (t.code ? [t.code] : [])));
  const project = await projectContext(root, config);

  let dsComponents = 0;
  let tokenColors = 0;
  for (const file of await resolveFiles(root, config, undefined, undefined)) {
    if (file.startsWith(`${config.uiDir}/`) || project.tokenSources.has(file) || config.themeFiles.includes(file)) continue;
    const text = await readFile(path.join(root, file), "utf8");
    if (STYLESHEET.test(file)) {
      tokenColors += [...text.matchAll(VAR_REFERENCE)].filter((m) => cssVars.has(m[1])).length;
      continue;
    }
    let ast: ReturnType<typeof parseCode>;
    try {
      ast = /\.(vue|svelte)$/.test(file) ? parseSfc(text, file).ast : parseCode(text, file);
    } catch {
      continue;
    }
    const imports = collectImports(ast);
    walk(ast, (node) => {
      if (node.type === "JSXOpeningElement" && node.name.type === "JSXIdentifier") {
        const local = node.name.name;
        const binding = imports.find((b) => b.local === local);
        if (binding && resolveComponent(binding, file, config, spec)) dsComponents++;
      }
      // colors.label, theme.palette.primary.main
      if (node.type === "MemberExpression" && codes.size) {
        const chain = memberChain(node);
        if (chain && codes.has(chain)) tokenColors++;
      }
      // Chakra / Mantine / MUI style props and sx values naming theme colors: bg="brand.500"
      if (node.type === "StringLiteral" && utilities.has(node.value) && node.value.includes(".")) tokenColors++;
    });
    for (const classString of collectClassStrings(ast, text, config.classFunctions)) {
      for (const token of tokenizeClasses(classString)) {
        const color = COLOR_UTILITY.exec(token.utility)?.[2];
        if ((color && utilities.has(color)) || [...token.utility.matchAll(VAR_REFERENCE)].some((m) => cssVars.has(m[1]))) tokenColors++;
      }
    }
  }

  const pct = (good: number, bad: number) => (good + bad ? Math.round((good / (good + bad)) * 100) : undefined);
  return {
    components: { ds: dsComponents, bypassed: bypassedComponents },
    colors: { tokens: tokenColors, bypassed: bypassedColors },
    componentScore: pct(dsComponents, bypassedComponents),
    colorScore: pct(tokenColors, bypassedColors),
    score: pct(dsComponents + tokenColors, bypassedComponents + bypassedColors),
  };
}

function memberChain(node: import("@babel/types").Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression" || node.computed || node.property.type !== "Identifier") return undefined;
  const object = memberChain(node.object);
  return object ? `${object}.${node.property.name}` : undefined;
}

export function formatAdoption(a: Adoption): string {
  const show = (score: number | undefined, good: number, bad: number, what: string, via: string) =>
    score === undefined ? `${what}: nothing to measure` : `${what}: ${score}% (${good} ${via}, ${bad} bypassing it)`;
  return [
    `Design system adoption: ${a.score === undefined ? "n/a" : `${a.score}%`}`,
    `  ${show(a.componentScore, a.components.ds, a.components.bypassed, "Components", "from the design system")}`,
    `  ${show(a.colorScore, a.colors.tokens, a.colors.bypassed, "Colors", "through tokens")}`,
  ].join("\n");
}
