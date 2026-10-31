import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Node, ObjectExpression } from "@babel/types";
import { parseColor } from "../color.js";
import { parseCode, propertyKey, walk } from "../source.js";
import type { Token } from "../spec.js";

const DIMENSION = /^-?[\d.]+(px|rem|em|%|pt|dp)?$/;

/**
 * Reads tokens from JS/TS theme modules without executing them:
 *
 *   export const spacing = { sm: 8, md: 16 }           -> spacing.sm, spacing.md
 *   const specs = { label: token("#000", ...) }
 *   export const colors = {} as Record<keyof typeof specs, ColorValue>  -> colors.label = #000
 *
 * Platform-dependent values (`isAndroid ? 48 : 44`) are skipped; for calls the first literal
 * argument is used, which is how fallback values are usually passed.
 */
export async function extractThemeTokens(root: string, files: string[]): Promise<Token[]> {
  const tokens: Token[] = [];
  for (const file of files) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    let program: Node[];
    try {
      program = parseCode(await readFile(abs, "utf8"), file).program.body;
    } catch {
      continue;
    }

    const locals = new Map<string, Node>();
    const exported: Array<{ name: string; init: Node }> = [];
    const exportedNames = new Set<string>();
    for (const statement of program) {
      if (statement.type === "ExportNamedDeclaration" && !statement.source) {
        for (const spec of statement.specifiers) {
          if (spec.type === "ExportSpecifier" && spec.local.type === "Identifier") exportedNames.add(spec.local.name);
        }
      }
      // `export default createTheme({...})` (MUI) or `export default { colors }`.
      if (statement.type === "ExportDefaultDeclaration" && statement.declaration.type !== "FunctionDeclaration" && statement.declaration.type !== "ClassDeclaration") {
        exported.push({ name: "theme", init: statement.declaration as Node });
        continue;
      }
      const decl = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (decl?.type !== "VariableDeclaration") continue;
      for (const d of decl.declarations) {
        if (d.id.type !== "Identifier" || !d.init) continue;
        locals.set(d.id.name, d.init);
        if (statement.type === "ExportNamedDeclaration") exported.push({ name: d.id.name, init: d.init });
      }
    }
    for (const name of exportedNames) {
      const init = locals.get(name);
      if (init && !exported.some((e) => e.name === name)) exported.push({ name, init });
    }

    for (const { name, init } of exported) {
      // createSystem(defaultConfig, {...}), createTheme({...}), extendTheme({...}): the object passed in.
      const called = unwrap(init);
      if (called.type === "CallExpression") {
        const config = [...called.arguments].reverse().find((a) => a.type === "ObjectExpression");
        if (config?.type === "ObjectExpression") flatten([name], config, tokens, file);
        continue;
      }
      let object = unwrap(init);
      if (object.type !== "ObjectExpression" || object.properties.length === 0) {
        // `{} as Record<keyof typeof specs, ...>`: the keys come from another object.
        const source = keyofTypeofTarget(init);
        const target = source ? locals.get(source) : undefined;
        if (!target) continue;
        object = unwrap(target);
      }
      if (object.type === "ObjectExpression") flatten([name], object, tokens, file);
    }
  }
  // Chakra references: "{colors.gray.600}" → that token's value.
  const byReference = new Map(tokens.flatMap((t) => (t.utility ? [[t.utility, t] as const] : [])));
  for (const token of tokens) {
    const ref = (value: string) => /^\{(?:colors\.)?([^}]+)\}$/.exec(value)?.[1];
    const target = ref(token.value) && byReference.get(ref(token.value)!);
    if (target) {
      token.value = target.value;
      token.type = target.type;
    }
    const dark = token.modes?.dark && ref(token.modes.dark) && byReference.get(ref(token.modes.dark)!);
    if (dark && token.modes) token.modes.dark = dark.value;
  }
  return tokens;
}

function flatten(pathParts: string[], object: ObjectExpression, out: Token[], source: string): void {
  const entries: Array<[string, Node]> = object.properties.flatMap((prop) => {
    const key = prop.type === "ObjectProperty" ? propertyKey(prop.key) : undefined;
    return key && prop.type === "ObjectProperty" ? [[key, prop.value as Node] as [string, Node]] : [];
  });
  flattenEntries(pathParts, entries, out, source);
}

function flattenEntries(pathParts: string[], entries: Array<[string, Node]>, out: Token[], source: string): void {
  for (const [key, raw] of entries) {
    const value = unwrap(raw);
    const parts = [...pathParts, key];
    // Chakra token: { value: "#1850ff" } or a semantic token { value: { base, _dark } }.
    const tokenValue = value.type === "ObjectExpression" ? objectProperty(value, "value") : undefined;
    if (tokenValue) {
      const conditions = unwrap(tokenValue);
      if (conditions.type === "ObjectExpression") {
        const base = objectProperty(conditions, "base");
        const dark = objectProperty(conditions, "_dark");
        const baseValue = base ? leafValue(unwrap(base)) : undefined;
        const darkValue = dark ? leafValue(unwrap(dark)) : undefined;
        if (baseValue !== undefined) push(out, parts, baseValue, source, darkValue);
      } else {
        const leaf = leafValue(conditions);
        if (leaf !== undefined) push(out, parts, leaf, source);
      }
      continue;
    }
    if (value.type === "ObjectExpression") {
      flatten(parts, value, out, source);
      continue;
    }
    // Mantine color scales: brand: ["#f0f4ff", …] → brand.0 … brand.9
    if (value.type === "ArrayExpression") {
      flattenEntries(parts, value.elements.flatMap((el, i) => (el && el.type !== "SpreadElement" ? [[String(i), el as Node] as [string, Node]] : [])), out, source);
      continue;
    }
    const leaf = leafValue(value);
    if (leaf !== undefined) push(out, parts, leaf, source);
  }
}

// Where component libraries keep colors: the part after it is how style props name the color.
const COLOR_GROUPS = ["colors", "palette"];

function push(out: Token[], parts: string[], value: string, source: string, dark?: string): void {
  const type = parseColor(value) ? "color" : DIMENSION.test(value) ? "dimension" : "other";
  let group = -1;
  parts.forEach((part, i) => {
    if (COLOR_GROUPS.includes(part)) group = i;
  });
  out.push({
    name: parts.join("-"),
    type,
    value,
    code: parts.join("."),
    source,
    // bg="brand.500" (Chakra), c="brand.6" (Mantine), color: "primary.main" (MUI)
    ...(group >= 0 && group < parts.length - 1 ? { utility: parts.slice(group + 1).join(".") } : {}),
    ...(dark !== undefined && dark !== value ? { modes: { dark } } : {}),
  });
}

function objectProperty(object: ObjectExpression, name: string): Node | undefined {
  for (const prop of object.properties) if (prop.type === "ObjectProperty" && propertyKey(prop.key) === name) return prop.value as Node;
  return undefined;
}

function leafValue(node: Node): string | undefined {
  switch (node.type) {
    case "NumericLiteral":
      return String(node.value);
    case "StringLiteral":
      return node.value;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? node.quasis[0]?.value.cooked ?? undefined : undefined;
    case "UnaryExpression":
      return node.operator === "-" && node.argument.type === "NumericLiteral" ? String(-node.argument.value) : undefined;
    case "CallExpression":
      for (const arg of node.arguments) {
        if (arg.type === "StringLiteral" || arg.type === "NumericLiteral") return String(arg.value);
      }
      return undefined;
    case "ConditionalExpression": {
      // Only when one branch is dynamic, e.g. `brand ? brandToken(brand.accent) : token("#007aff", ...)`.
      const consequent = leafValue(unwrap(node.consequent));
      const alternate = leafValue(unwrap(node.alternate));
      return consequent === undefined ? alternate : alternate === undefined ? consequent : undefined;
    }
    default:
      return undefined;
  }
}

function unwrap(node: Node): Node {
  let current = node;
  while (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression;
  }
  return current;
}

function keyofTypeofTarget(node: Node): string | undefined {
  let target: string | undefined;
  walk(node, (n) => {
    if (!target && n.type === "TSTypeOperator" && n.operator === "keyof" && n.typeAnnotation.type === "TSTypeQuery" && n.typeAnnotation.exprName.type === "Identifier") {
      target = n.typeAnnotation.exprName.name;
    }
  });
  return target;
}
