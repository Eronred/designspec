import { parseExpression } from "@babel/parser";
import type { File, Node } from "@babel/types";
import { parseCode, walk } from "../source.js";

export interface SfcStyle {
  css: string;
  lang: "css" | "scss" | "less";
  toSource(index: number): number;
}

export interface ParsedSfc {
  /** The script's AST plus the template's elements as JSX nodes, all at file positions. */
  ast: File;
  styles: SfcStyle[];
}

interface Range {
  start: number;
  end: number;
}

const BLOCK = /<(script|style)(\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;

/**
 * Turns a Vue or Svelte single-file component into what the rules already understand: the script as a
 * normal AST, and template elements as JSX elements (`class` → `className`, `<my-button>` → `MyButton`,
 * `:variant="'x'"` / `{expr}` parsed as expressions). Everything keeps its position in the file.
 */
export function parseSfc(text: string, file: string): ParsedSfc {
  const scripts: Range[] = [];
  const styles: SfcStyle[] = [];
  let lang = "js";
  for (const match of text.matchAll(BLOCK)) {
    const [whole, kind, attrs = "", content] = match;
    const contentStart = match.index! + whole.indexOf(">") + 1;
    if (kind.toLowerCase() === "script") {
      scripts.push({ start: contentStart, end: contentStart + content.length });
      const scriptLang = /\blang=["']?(ts|tsx|jsx)/.exec(attrs)?.[1];
      if (scriptLang) lang = scriptLang;
    } else {
      const styleLang = /\blang=["']?(scss|less)/.exec(attrs)?.[1] as "scss" | "less" | undefined;
      styles.push({ css: content, lang: styleLang ?? "css", toSource: (i) => contentStart + i });
    }
  }

  // Parsing the file with everything but the scripts blanked keeps every position as in the file.
  const scriptAst = parseCode(mask(text, scripts), `component.${lang}`);
  // Svelte markup is the whole file; <script> and <style> are blanked while reading tags.
  const template = file.endsWith(".vue") ? vueTemplate(text) : { start: 0, end: text.length };
  const elements = template ? parseElements(text, template, file.endsWith(".vue") ? "vue" : "svelte", styles) : [];

  const fragment = { type: "JSXFragment", children: elements.map((openingElement) => ({ type: "JSXElement", openingElement, children: [], closingElement: null })) };
  const ast = {
    ...scriptAst,
    program: { ...scriptAst.program, body: [...scriptAst.program.body, { type: "ExpressionStatement", expression: fragment }] },
  } as unknown as File;
  return { ast, styles };
}

function mask(text: string, keep: Range[]): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const kept = keep.some((r) => i >= r.start && i < r.end);
    out += kept || text[i] === "\n" ? text[i] : " ";
  }
  return out;
}

/** The top-level <template> (nested <template v-if> blocks included). */
function vueTemplate(text: string): Range | undefined {
  const open = /<template(\s[^>]*)?>/i.exec(text);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  let depth = 1;
  const tags = /<(\/?)template(\s[^>]*)?>/gi;
  tags.lastIndex = start;
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return { start, end: match.index };
  }
  return { start, end: text.length };
}

const NON_ELEMENT = /^(svelte:|slot$|template$)/;

function parseElements(text: string, region: Range, dialect: "vue" | "svelte", styles: SfcStyle[]): Node[] {
  // Comments and (for Svelte) script/style blocks are blanked so their contents aren't read as tags.
  let scan = text.slice(0, region.end).replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  scan = scan.replace(BLOCK, (m) => " ".repeat(m.length));
  const elements: Node[] = [];
  const tag = /<([A-Za-z][\w:.-]*)/g;
  tag.lastIndex = region.start;
  for (let match = tag.exec(scan); match; match = tag.exec(scan)) {
    const rawName = match[1];
    const start = match.index;
    const { attributes, end } = parseAttributes(scan, text, start + 1 + rawName.length, dialect, styles);
    tag.lastIndex = end;
    if (NON_ELEMENT.test(rawName)) continue;
    // Vue lets components be written in kebab-case: <my-button> is MyButton.
    const name = dialect === "vue" && rawName.includes("-") ? rawName.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()) : rawName;
    elements.push({ type: "JSXOpeningElement", name: { type: "JSXIdentifier", name, start: start + 1, end: start + 1 + rawName.length }, attributes, selfClosing: false, start, end } as unknown as Node);
  }
  return elements;
}

function parseAttributes(scan: string, text: string, from: number, dialect: "vue" | "svelte", styles: SfcStyle[]): { attributes: Node[]; end: number } {
  const attributes: Node[] = [];
  let i = from;
  while (i < scan.length) {
    while (/\s/.test(scan[i] ?? "")) i++;
    if (scan[i] === ">" || scan.startsWith("/>", i) || i >= scan.length) break;
    // Svelte shorthand {name} and spreads {...props}
    if (scan[i] === "{") {
      i = matchBrace(scan, i) + 1;
      continue;
    }
    const nameMatch = /^[^\s=/>]+/.exec(scan.slice(i));
    if (!nameMatch) {
      i++;
      continue;
    }
    const name = nameMatch[0];
    i += name.length;
    let value: { text: string; start: number; kind: "string" | "expression" } | undefined;
    if (scan[i] === "=") {
      i++;
      const quote = scan[i];
      if (quote === '"' || quote === "'") {
        const close = scan.indexOf(quote, i + 1);
        value = { text: text.slice(i + 1, close), start: i, kind: "string" };
        i = close + 1;
      } else if (quote === "{") {
        const close = matchBrace(scan, i);
        value = { text: text.slice(i + 1, close), start: i + 1, kind: "expression" };
        i = close + 1;
      } else {
        const raw = /^[^\s>]+/.exec(scan.slice(i))?.[0] ?? "";
        value = { text: raw, start: i - 1, kind: "string" };
        i += raw.length;
      }
    }
    const attribute = toJsxAttribute(name, value, dialect, styles);
    if (attribute) attributes.push(attribute);
  }
  return { attributes, end: scan.startsWith("/>", i) ? i + 2 : i + 1 };
}

function matchBrace(scan: string, open: number): number {
  let depth = 0;
  for (let i = open; i < scan.length; i++) {
    if (scan[i] === "{") depth++;
    else if (scan[i] === "}" && --depth === 0) return i;
  }
  return scan.length;
}

function toJsxAttribute(rawName: string, value: { text: string; start: number; kind: "string" | "expression" } | undefined, dialect: "vue" | "svelte", styles: SfcStyle[]): Node | undefined {
  // Vue :prop / v-bind:prop take expressions; events, directives and slots aren't attributes to check.
  const bound = dialect === "vue" && /^(:|v-bind:)/.test(rawName);
  const name = rawName.replace(/^(:|v-bind:)/, "");
  if (/^(v-|@|#|on:|bind:|use:|transition:|in:|out:|animate:|let:|class:|style:)/.test(name)) return undefined;
  if (!value) return undefined;

  const jsxName = name === "class" ? "className" : name;
  if (!bound && value.kind === "string") {
    // Inline CSS: style="color: #fff"
    if (name === "style" && !value.text.includes("{")) {
      const start = value.start + 1;
      styles.push({ css: value.text, lang: "css", toSource: (i) => start + i });
      return undefined;
    }
    return { type: "JSXAttribute", name: { type: "JSXIdentifier", name: jsxName }, value: { type: "StringLiteral", value: value.text, start: value.start, end: value.start + value.text.length + 2 } } as unknown as Node;
  }
  const exprStart = value.kind === "string" ? value.start + 1 : value.start;
  try {
    const expression = parseExpression(value.text, { plugins: ["typescript"] }) as Node;
    // Shift positions from the attribute value to the file.
    walk(expression, (node) => {
      if (node.start != null) node.start += exprStart;
      if (node.end != null) node.end += exprStart;
    });
    return { type: "JSXAttribute", name: { type: "JSXIdentifier", name: jsxName }, value: { type: "JSXExpressionContainer", expression } } as unknown as Node;
  } catch {
    return undefined;
  }
}
