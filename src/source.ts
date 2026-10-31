import { parse, type ParserPlugin } from "@babel/parser";
import type { File, Node } from "@babel/types";

/** A source file with fast index -> line/column lookups. */
export class SourceText {
  readonly lines: string[];
  private readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
    this.lines = text.split("\n");
  }

  position(index: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - this.lineStarts[lo] + 1 };
  }
}

export function parseCode(code: string, filename: string): File {
  const plugins: ParserPlugin[] = [];
  const isTs = /\.[mc]?tsx?$/.test(filename);
  if (isTs) plugins.push("typescript");
  // Plain .ts files can't contain JSX (`<T>x` is a type assertion there).
  if (!/\.[mc]?ts$/.test(filename)) plugins.push("jsx");
  return parse(code, { sourceType: "module", plugins, errorRecovery: true });
}

const SKIP_KEYS = new Set(["loc", "start", "end", "range", "extra", "comments", "leadingComments", "trailingComments", "innerComments", "tokens"]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Depth-first walk over every AST node. */
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

export function propertyKey(key: Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  if (key.type === "NumericLiteral") return String(key.value);
  return undefined;
}
