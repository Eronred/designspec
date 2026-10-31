import type { Node } from "@babel/types";
import { propertyKey, walk } from "../../source.js";
import { resolveComponent } from "../imports.js";
import type { FileRule } from "../types.js";

export const noUnknownVariant: FileRule = {
  id: "no-unknown-variant",
  description: "Disallow variant values that are not defined in the component's spec (<Button variant=\"ghost2\">).",
  defaultLevel: "error",
  runsInUiDir: true,
  idleReason: (spec) => (spec.components.some((c) => Object.keys(c.variants).length) ? undefined : "no component has variants"),
  check(ctx) {
    // local name -> variants of the imported export
    const variantsByLocal = new Map<string, Record<string, string[]>>();
    for (const binding of ctx.imports) {
      const component = resolveComponent(binding, ctx.file, ctx.config, ctx.spec);
      const variants = component?.variants[binding.imported];
      if (variants && Object.keys(variants).length) variantsByLocal.set(binding.local, variants);
    }
    if (variantsByLocal.size === 0) return;

    const verify = (local: string, prop: string, value: Node | null | undefined) => {
      const allowed = variantsByLocal.get(local)?.[prop];
      if (!allowed || value?.type !== "StringLiteral" || allowed.includes(value.value)) return;
      ctx.report(value.start! + 1, `"${value.value}" is not a ${prop} of ${local}.`, `Allowed: ${allowed.join(", ")}. Need a new one? Run \`designspec propose\`.`);
    };

    walk(ctx.ast, (node) => {
      // <Button variant="x">
      if (node.type === "JSXOpeningElement" && node.name.type === "JSXIdentifier" && variantsByLocal.has(node.name.name)) {
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier") continue;
          const value = attribute.value?.type === "JSXExpressionContainer" ? (attribute.value.expression as Node) : attribute.value;
          verify(node.name.name, attribute.name.name, value);
        }
      }
      // buttonVariants({ variant: "x" })
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && variantsByLocal.has(node.callee.name)) {
        const options = node.arguments[0];
        if (options?.type !== "ObjectExpression") return;
        for (const prop of options.properties) {
          if (prop.type !== "ObjectProperty") continue;
          const key = propertyKey(prop.key);
          if (key) verify(node.callee.name, key, prop.value);
        }
      }
    });
  },
};
