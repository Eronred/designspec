import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Node, ObjectExpression } from "@babel/types";
import { parseColor } from "../color.js";
import { parseCode, propertyKey, walk } from "../source.js";
import type { Token } from "../spec.js";

export interface TailwindConfigColors {
  /** CSS variable -> utility suffix, from `primary: "hsl(var(--primary))"`. */
  utilities: Map<string, string>;
  /** Colors defined directly in the config, e.g. `brand: "#1850ff"`. */
  tokens: Token[];
}

/** Reads `theme.colors` and `theme.extend.colors` from a Tailwind v3 config without executing it. */
export async function readTailwindConfig(root: string, file: string): Promise<TailwindConfigColors> {
  const result: TailwindConfigColors = { utilities: new Map(), tokens: [] };
  const abs = path.join(root, file);
  if (!existsSync(abs)) return result;
  let ast: ReturnType<typeof parseCode>;
  try {
    ast = parseCode(await readFile(abs, "utf8"), file);
  } catch {
    return result;
  }

  walk(ast, (node) => {
    if (node.type !== "ObjectProperty" || propertyKey(node.key) !== "theme" || node.value.type !== "ObjectExpression") return;
    const theme = node.value;
    const extend = property(theme, "extend");
    for (const colors of [property(theme, "colors"), extend?.type === "ObjectExpression" ? property(extend, "colors") : undefined]) {
      if (colors?.type === "ObjectExpression") collect([], colors, result);
    }
  });
  return result;
}

function collect(parts: string[], object: ObjectExpression, out: TailwindConfigColors): void {
  for (const prop of object.properties) {
    if (prop.type !== "ObjectProperty") continue;
    const key = propertyKey(prop.key);
    if (!key) continue;
    const next = key === "DEFAULT" ? parts : [...parts, key];
    if (prop.value.type === "ObjectExpression") {
      collect(next, prop.value, out);
      continue;
    }
    if (prop.value.type !== "StringLiteral" || next.length === 0) continue;
    const utility = next.join("-");
    const value = prop.value.value;
    const cssVar = /var\(\s*(--[\w-]+)/.exec(value)?.[1];
    if (cssVar) out.utilities.set(cssVar, utility);
    else if (parseColor(value)) out.tokens.push({ name: utility, type: "color", value, utility });
  }
}

function property(object: ObjectExpression, name: string): Node | undefined {
  for (const prop of object.properties) {
    if (prop.type === "ObjectProperty" && propertyKey(prop.key) === name) return prop.value;
  }
  return undefined;
}
