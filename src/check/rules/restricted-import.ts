import picomatch from "picomatch";
import type { Config, RestrictedImport } from "../../config.js";
import { collectImportSources } from "../imports.js";
import type { FileRule } from "../types.js";

const PRESET_IMPORTS: Record<string, string[]> = {
  "base-ui": ["@base-ui-components/react", "@base-ui-components/react/**", "@base-ui/react", "@base-ui/react/**"],
  radix: ["radix-ui", "radix-ui/**", "@radix-ui/**"],
};

/** Headless primitives from presets may only be imported inside the UI directory, plus user-defined restrictions. */
export function restrictedImports(config: Config): RestrictedImport[] {
  const fromPresets = config.presets
    .filter((preset) => preset in PRESET_IMPORTS)
    .map((preset) => ({
      from: PRESET_IMPORTS[preset],
      allowIn: [`${config.uiDir}/**`],
      message: `Headless primitives must be wrapped in ${config.uiImport}; import the wrapper instead.`,
    }));
  return [...fromPresets, ...config.restrictedImports];
}

export const restrictedImport: FileRule = {
  id: "restricted-import",
  description: "Disallow importing headless primitives (Base UI, Radix) or other restricted modules outside allowed paths.",
  defaultLevel: "error",
  runsInUiDir: true,
  check(ctx) {
    const restrictions = restrictedImports(ctx.config).map((r) => ({
      ...r,
      matchesSource: picomatch(r.from),
      allowedHere: r.allowIn.length > 0 && picomatch(r.allowIn)(ctx.file),
    }));
    for (const { source, start } of collectImportSources(ctx.ast)) {
      const restriction = restrictions.find((r) => !r.allowedHere && r.matchesSource(source));
      if (!restriction) continue;
      ctx.report(start + 1, `Import of "${source}" is not allowed here.`, restriction.message ?? `Allowed only in: ${restriction.allowIn.join(", ")}`);
    }
  },
};
