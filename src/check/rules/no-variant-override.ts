import { walk } from "../../source.js";
import { classStringsIn, tokenizeClasses, utilityFamily } from "../classes.js";
import { resolveComponent } from "../imports.js";
import type { FileRule } from "../types.js";

export const noVariantOverride: FileRule = {
  id: "no-variant-override",
  description: "Disallow className utilities that override what a variant controls (<Button className=\"h-12\"> instead of a size).",
  defaultLevel: "error",
  runsInUiDir: false,
  idleReason: (spec) =>
    spec.components.some((c) => Object.keys(c.controls).length) ? undefined : "no component variants set classes (cva) to protect",
  check(ctx) {
    // Exact classes that are fine anyway, e.g. ["rounded-none"] for a button fused into an input group.
    const allow = new Set((ctx.options.allow as string[] | undefined) ?? []);
    const byLocal = new Map<string, { controls: Record<string, string[]>; variants: Record<string, string[]> }>();
    for (const binding of ctx.imports) {
      const component = resolveComponent(binding, ctx.file, ctx.config, ctx.spec);
      const controls = component?.controls[binding.imported];
      if (component && controls && Object.keys(controls).length) {
        byLocal.set(binding.local, { controls, variants: component.variants[binding.imported] ?? {} });
      }
    }
    if (byLocal.size === 0) return;

    walk(ctx.ast, (node) => {
      if (node.type !== "JSXOpeningElement" || node.name.type !== "JSXIdentifier") return;
      const local = node.name.name;
      const component = byLocal.get(local);
      if (!component) return;
      const className = node.attributes.find((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "className");
      if (className?.type !== "JSXAttribute") return;

      for (const token of classStringsIn(className.value, ctx.source.text).flatMap((s) => tokenizeClasses(s))) {
        const family = utilityFamily(token.utility);
        if (!family || allow.has(token.utility)) continue;
        const prop = Object.keys(component.controls).find((p) => component.controls[p].includes(family));
        if (!prop) continue;
        const options = component.variants[prop]?.join(", ");
        ctx.report(token.index, `"${token.raw}" overrides the ${family} that ${local}'s ${prop} variant controls.`, `Pick a ${prop} instead${options ? ` (${options})` : ""}, or propose a new one with \`designspec propose\`.`);
      }
    });
  },
};
