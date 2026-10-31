import type { JSXAttribute, JSXOpeningElement } from "@babel/types";
import { walk } from "../../source.js";
import type { ComponentSpec } from "../../spec.js";
import type { FileRule } from "../types.js";

// `<input>` types that are not text fields and need a different component (or none).
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "hidden", "file", "range", "color", "submit", "reset", "button", "image"]);
const ELEMENT_SELECTOR = /^([a-z][a-z0-9-]*)(?:\[type=["']?([\w-]+)["']?\])?$/;
// `react-native:TouchableOpacity`: the `TouchableOpacity` export of the `react-native` module.
const MODULE_SELECTOR = /^(@?[\w./-]+):([A-Z][\w]*)$/;

interface Replacement {
  component: ComponentSpec;
  tag?: string;
  type?: string;
  module?: string;
  name?: string;
}

export const preferDsComponent: FileRule = {
  id: "prefer-ds-component",
  description: "Disallow native elements (<button>) or platform primitives (react-native TouchableOpacity) when the design system replaces them.",
  defaultLevel: "error",
  runsInUiDir: false,
  idleReason: (spec) => (spec.components.some((c) => c.replaces.length) ? undefined : "no component lists what it replaces"),
  check(ctx) {
    const replacements: Replacement[] = [];
    for (const component of ctx.spec.components) {
      for (const selector of component.replaces) {
        const element = ELEMENT_SELECTOR.exec(selector.trim());
        const module = MODULE_SELECTOR.exec(selector.trim());
        if (element) replacements.push({ component, tag: element[1], type: element[2] });
        else if (module) replacements.push({ component, module: module[1], name: module[2] });
      }
    }
    if (replacements.length === 0) return;
    const imports = new Map(ctx.imports.map((b) => [b.local, b]));

    walk(ctx.ast, (node) => {
      if (node.type !== "JSXOpeningElement" || node.name.type !== "JSXIdentifier") return;
      const tag = node.name.name;
      let replacement: Replacement | undefined;
      let element: string;

      if (tag[0] === tag[0].toLowerCase()) {
        const type = literalAttribute(node, "type");
        replacement =
          replacements.find((r) => r.tag === tag && r.type !== undefined && r.type === type) ??
          replacements.find((r) => r.tag === tag && r.type === undefined && !(tag === "input" && type && NON_TEXT_INPUTS.has(type)));
        element = `Native ${type ? `<${tag} type="${type}">` : `<${tag}>`}`;
      } else {
        const binding = imports.get(tag);
        if (!binding) return;
        replacement = replacements.find((r) => r.module === binding.source && r.name === binding.imported);
        element = `<${binding.imported}> from "${binding.source}"`;
      }
      if (!replacement) return;
      const { component } = replacement;
      const name = component.exports.includes(component.name) ? component.name : component.exports[0];
      ctx.report(node.start!, `${element} used; the design system provides <${name}>.`, `import { ${name} } from "${component.import}"`);
    });
  },
};

function literalAttribute(node: JSXOpeningElement, name: string): string | undefined {
  const attribute = node.attributes.find((a): a is JSXAttribute => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name);
  return attribute?.value?.type === "StringLiteral" ? attribute.value.value : undefined;
}
