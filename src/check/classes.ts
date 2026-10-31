import type { File, Node } from "@babel/types";
import { walk } from "../source.js";

export interface ClassString {
  text: string;
  /** Absolute index of `text[0]` in the source. */
  start: number;
}

export interface ClassToken {
  raw: string;
  /** The class without variants (`hover:`, `md:`), `!` or a leading `-`. */
  utility: string;
  index: number;
}

/** Collects string literals used as classes: `className` attributes and calls like `cn()`, `clsx()`, `cva()`. */
export function collectClassStrings(ast: File, source: string, classFunctions: string[]): ClassString[] {
  const functions = new Set(classFunctions);
  const seen = new Set<number>();
  const out: ClassString[] = [];
  const add = (classString: ClassString) => {
    if (seen.has(classString.start)) return;
    seen.add(classString.start);
    out.push(classString);
  };
  walk(ast, (node) => {
    if (node.type === "JSXAttribute" && node.name.type === "JSXIdentifier" && (node.name.name === "className" || node.name.name === "class")) {
      classStringsIn(node.value, source).forEach(add);
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && functions.has(node.callee.name)) {
      classStringsIn(node, source).forEach(add);
    }
  });
  return out;
}

/** String literals inside an expression that can end up in a class list. */
export function classStringsIn(root: Node | null | undefined, source: string): ClassString[] {
  const out: ClassString[] = [];
  const add = (text: string, start: number) => {
    if (text) out.push({ text, start });
  };

  const gather = (node: Node | null | undefined): void => {
    if (!node) return;
    switch (node.type) {
      case "StringLiteral":
        add(node.value, node.start! + 1);
        break;
      case "TemplateLiteral":
        for (const quasi of node.quasis) {
          const at = source.indexOf(quasi.value.raw, Math.max(0, quasi.start! - 1));
          add(quasi.value.raw, at >= 0 ? at : quasi.start!);
        }
        for (const expression of node.expressions) gather(expression);
        break;
      case "JSXExpressionContainer":
        gather(node.expression as Node);
        break;
      case "ConditionalExpression":
        gather(node.consequent);
        gather(node.alternate);
        break;
      case "LogicalExpression":
        gather(node.left);
        gather(node.right);
        break;
      case "ArrayExpression":
        for (const element of node.elements) gather(element);
        break;
      case "ObjectExpression":
        for (const prop of node.properties) {
          if (prop.type !== "ObjectProperty") continue;
          if (prop.key.type === "StringLiteral") gather(prop.key);
          gather(prop.value);
        }
        break;
      case "CallExpression":
        for (const arg of node.arguments) gather(arg);
        break;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "ParenthesizedExpression":
        gather(node.expression);
        break;
    }
  };

  gather(root);
  return out;
}

export function tokenizeClasses(classString: ClassString): ClassToken[] {
  const tokens: ClassToken[] = [];
  for (const match of classString.text.matchAll(/\S+/g)) {
    tokens.push({ raw: match[0], utility: stripVariants(match[0]), index: classString.start + match.index! });
  }
  return tokens;
}

export function stripVariants(cls: string): string {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) cut = i + 1;
  }
  let base = cls.slice(cut);
  if (base.startsWith("!")) base = base.slice(1);
  if (base.endsWith("!")) base = base.slice(0, -1);
  if (base.startsWith("-")) base = base.slice(1);
  return base;
}

const FAMILIES: Array<[RegExp, string]> = [
  [/^(h|min-h|max-h|size)-/, "height"],
  [/^p[xytrblse]?-/, "padding"],
  [/^rounded(-[a-z]{1,2})?(-|$)/, "radius"],
];

/** Groups utilities that set the same visual property, e.g. `h-9` and `size-9` both set "height". */
export function utilityFamily(utility: string): string | undefined {
  return FAMILIES.find(([pattern]) => pattern.test(utility))?.[1];
}

const ARBITRARY = /^([a-z][a-z0-9-]*?)-\[(.+)\](?:\/\S+)?$/;
const ARBITRARY_PROPERTY = /^\[([a-z-]+):(.+)\]$/;
const TYPE_HINT = /^(color|length|percentage|number|url|image|position|size|family-name|line-width|shadow|angle):/;

/** `p-[13px]` -> `{ prefix: "p", value: "13px" }`; `[color:red]` -> `{ prefix: "[color]", value: "red" }`. */
export function arbitraryValue(utility: string): { prefix: string; value: string } | null {
  const match = ARBITRARY.exec(utility);
  if (match) return { prefix: match[1], value: match[2].replace(TYPE_HINT, "") };
  const property = ARBITRARY_PROPERTY.exec(utility);
  if (property) return { prefix: `[${property[1]}]`, value: property[2] };
  return null;
}
