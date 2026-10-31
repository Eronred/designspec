import type { File, Node } from "@babel/types";
import { propertyKey, walk } from "../source.js";
import { collectImports } from "./imports.js";
import { isStyledObjectCall, styledLocals } from "./styled.js";

export interface StyleProperty {
  key: string;
  value: Node;
}

/**
 * Properties of inline style objects: `style={...}`, MUI `sx={...}`, Emotion `css={...}` and `*Style={...}` props
 * (including arrays and conditionals), every style in `StyleSheet.create({...})`, and object styles passed to
 * styled-components / Emotion (`styled.div({...})`). Nested objects are flattened.
 */
export function collectStyleProperties(ast: File): StyleProperty[] {
  const out: StyleProperty[] = [];
  const seen = new Set<number>();

  const fromObject = (node: Node): void => {
    if (node.type !== "ObjectExpression" || seen.has(node.start!)) return;
    seen.add(node.start!);
    for (const prop of node.properties) {
      if (prop.type !== "ObjectProperty") continue;
      const key = propertyKey(prop.key);
      if (!key) continue;
      if (prop.value.type === "ObjectExpression") fromObject(prop.value);
      else if (prop.value.type === "ArrayExpression") prop.value.elements.forEach((e) => e && fromExpression(e));
      else out.push({ key, value: prop.value });
    }
  };

  const fromExpression = (node: Node | null | undefined): void => {
    if (!node) return;
    switch (node.type) {
      case "ObjectExpression":
        fromObject(node);
        break;
      case "ArrayExpression":
        for (const element of node.elements) fromExpression(element);
        break;
      case "ConditionalExpression":
        fromExpression(node.consequent);
        fromExpression(node.alternate);
        break;
      case "LogicalExpression":
        fromExpression(node.right);
        break;
      case "JSXExpressionContainer":
        fromExpression(node.expression as Node);
        break;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "ParenthesizedExpression":
        fromExpression(node.expression);
        break;
    }
  };

  const styled = styledLocals(collectImports(ast));
  walk(ast, (node) => {
    // style, MUI sx, Emotion css={{…}}, React Native *Style props.
    if (node.type === "JSXAttribute" && node.name.type === "JSXIdentifier" && /^(style|sx|css)$|Style$/.test(node.name.name)) {
      fromExpression(node.value);
    } else if (styled.size && isStyledObjectCall(node, styled) && node.type === "CallExpression") {
      for (const arg of node.arguments) fromExpression(arg.type === "ArrowFunctionExpression" ? (arg.body as Node) : arg);
    } else if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "StyleSheet" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "create"
    ) {
      const sheet = node.arguments[0];
      if (sheet?.type !== "ObjectExpression") return;
      for (const style of sheet.properties) {
        if (style.type === "ObjectProperty") fromExpression(style.value);
      }
    }
  });
  return out;
}

/** `16` -> 16, `-8` -> -8, anything else -> undefined. */
export function numericValue(node: Node): number | undefined {
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral") return -node.argument.value;
  return undefined;
}
