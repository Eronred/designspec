import path from "node:path";
import type { File } from "@babel/types";
import type { Config } from "../config.js";
import type { ComponentSpec, Spec } from "../spec.js";

export interface ImportBinding {
  local: string;
  /** Imported name, `default` or `*`. */
  imported: string;
  source: string;
  start: number;
}

export interface ImportSource {
  source: string;
  start: number;
}

export function collectImports(ast: File): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const statement of ast.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const spec of statement.specifiers) {
      const imported =
        spec.type === "ImportSpecifier"
          ? spec.imported.type === "Identifier"
            ? spec.imported.name
            : spec.imported.value
          : spec.type === "ImportDefaultSpecifier"
            ? "default"
            : "*";
      bindings.push({ local: spec.local.name, imported, source: statement.source.value, start: statement.source.start! });
    }
  }
  return bindings;
}

/** Every module specifier the file imports or re-exports from. */
export function collectImportSources(ast: File): ImportSource[] {
  const sources: ImportSource[] = [];
  for (const statement of ast.program.body) {
    if ((statement.type === "ImportDeclaration" || statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source) {
      sources.push({ source: statement.source.value, start: statement.source.start! });
    }
  }
  return sources;
}

/**
 * Resolves an import to the component spec it points at: by path (`@/components/ui/button`, `./button`), else
 * by export name for barrel imports (`import { Button } from "@acme/ui"`) and design system packages.
 */
export function resolveComponent(binding: Pick<ImportBinding, "source" | "imported">, fromFile: string, config: Config, spec: Spec): ComponentSpec | undefined {
  const byPath = resolveByPath(binding.source, fromFile, config, spec);
  if (byPath) return byPath;
  const barrel = binding.source === config.uiImport || config.uiPackages.includes(binding.source);
  return spec.components.find((c) => (c.import === binding.source || (barrel && c.source.startsWith(`${config.uiDir}/`))) && c.exports.includes(binding.imported));
}

function resolveByPath(specifier: string, fromFile: string, config: Config, spec: Spec): ComponentSpec | undefined {
  let target: string | undefined;
  if (specifier.startsWith(`${config.uiImport}/`)) {
    target = `${config.uiDir}/${specifier.slice(config.uiImport.length + 1)}`;
  } else if (specifier.startsWith(".")) {
    target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  }
  if (!target?.startsWith(`${config.uiDir}/`)) return undefined;
  const wanted = target.replace(/\.[jt]sx?$/, "");
  return spec.components.find((c) => {
    const source = c.source.replace(/\.[jt]sx?$/, "");
    return source === wanted || source === `${wanted}/index`;
  });
}
