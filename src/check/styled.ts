import type { File, Node } from "@babel/types";
import { walk } from "../source.js";
import type { ImportBinding } from "./imports.js";

const CSS_IN_JS = new Set(["styled-components", "@emotion/styled", "@emotion/react", "@emotion/css", "styled-components/native"]);

export interface StyledTemplate {
  /** The template as CSS, with `${…}` replaced by comments. */
  css: string;
  /** Maps an index in `css` to an index in the file. */
  toSource(index: number): number;
}

/**
 * CSS in tagged templates from styled-components / Emotion: styled.div`…`, styled(Button)`…`,
 * styled.div.attrs(…)`…`, css`…`, createGlobalStyle`…`, keyframes`…`. Only tags imported from those
 * libraries count, so an unrelated `css` helper isn't parsed as CSS.
 */
export function collectStyledTemplates(ast: File, imports: ImportBinding[]): StyledTemplate[] {
  const locals = new Set(imports.filter((b) => CSS_IN_JS.has(b.source)).map((b) => b.local));
  if (locals.size === 0) return [];
  const templates: StyledTemplate[] = [];

  walk(ast, (node) => {
    if (node.type !== "TaggedTemplateExpression") return;
    const root = rootIdentifier(node.tag);
    if (!root || !locals.has(root)) return;
    const segments: Array<{ cssStart: number; sourceStart: number; length: number }> = [];
    let css = "";
    node.quasi.quasis.forEach((quasi, i) => {
      // TemplateElement positions cover the raw text between the backtick / `${` / `}` delimiters.
      segments.push({ cssStart: css.length, sourceStart: quasi.start!, length: quasi.value.raw.length });
      css += quasi.value.raw;
      // A comment parses anywhere: in a value, a selector, or where a mixin declaration was.
      if (i < node.quasi.expressions.length) css += `/*${i}*/`;
    });
    templates.push({
      css,
      toSource(index) {
        const segment = [...segments].reverse().find((s) => s.cssStart <= index) ?? segments[0];
        return segment.sourceStart + Math.min(index - segment.cssStart, segment.length);
      },
    });
  });
  return templates;
}

function rootIdentifier(node: Node): string | undefined {
  let current: Node = node;
  for (let i = 0; i < 10; i++) {
    if (current.type === "Identifier") return current.name;
    if (current.type === "MemberExpression") current = current.object;
    else if (current.type === "CallExpression") current = current.callee as Node;
    else return undefined;
  }
  return undefined;
}

/** `styled.div({ color: "#fff" })` and `styled(Button)({…})`: object styles passed to a styled factory. */
export function isStyledObjectCall(node: Node, styledLocals: Set<string>): boolean {
  if (node.type !== "CallExpression") return false;
  const root = rootIdentifier(node.callee as Node);
  return root !== undefined && styledLocals.has(root) && node.arguments.some((a) => a.type === "ObjectExpression" || a.type === "ArrowFunctionExpression");
}

export function styledLocals(imports: ImportBinding[]): Set<string> {
  return new Set(imports.filter((b) => CSS_IN_JS.has(b.source)).map((b) => b.local));
}
