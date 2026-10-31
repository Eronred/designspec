import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Node, Statement } from "@babel/types";
import type { Config } from "../config.js";
import { parseCode, propertyKey } from "../source.js";
import type { ComponentSpec } from "../spec.js";
import { callableProps, literalUnion, typeMembers } from "./components.js";

const DEFAULT_REPLACES: Record<string, string[]> = {
  button: ["button"],
  input: ["input"],
  textarea: ["textarea"],
  select: ["select"],
  label: ["label"],
  table: ["table"],
  separator: ["hr"],
  divider: ["hr"],
  checkbox: ["input[type=checkbox]"],
  radio: ["input[type=radio]"],
  "radio-group": ["input[type=radio]"],
  slider: ["input[type=range]"],
  progress: ["progress"],
  dialog: ["dialog"],
};

/**
 * Component contracts for design system packages installed from npm (`uiPackages`), read from their type
 * declarations: variants come from string-literal union props, including `VariantProps<typeof cvaFn>`.
 * Re-exports (`export * from "./button"`) are followed inside the package.
 */
export async function extractPackageComponents(root: string, config: Config): Promise<Omit<ComponentSpec, "body">[]> {
  const components: Omit<ComponentSpec, "body">[] = [];
  for (const pkg of config.uiPackages) {
    const dir = findPackage(root, pkg);
    if (!dir) continue;
    const entry = await typesEntry(dir);
    if (!entry) continue;

    // One type namespace per package: compiled declarations reference types across files.
    const types = new Map<string, Node>();
    const exported: Array<{ name: string; file: string }> = [];
    const visited = new Set<string>();
    const visit = async (file: string, only?: Set<string>): Promise<void> => {
      if (visited.has(file + [...(only ?? [])].join()) || !existsSync(file)) return;
      visited.add(file + [...(only ?? [])].join());
      let body: Statement[];
      try {
        body = parseCode(await readFile(file, "utf8"), file.replace(/\.d\.[mc]?ts$/, ".ts")).program.body;
      } catch {
        return;
      }
      for (const statement of body) {
        const decl = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
        if (decl) collectTypes(decl, types);
        if (statement.type === "ExportAllDeclaration") {
          await visit(resolveDeclaration(file, statement.source.value) ?? "", only);
        } else if (statement.type === "ExportNamedDeclaration") {
          if (statement.source) {
            const names = new Set(statement.specifiers.flatMap((s) => (s.type === "ExportSpecifier" ? [exportName(s.exported)] : [])));
            await visit(resolveDeclaration(file, statement.source.value) ?? "", names);
            continue;
          }
          const names = decl ? declaredNames(decl) : statement.specifiers.flatMap((s) => (s.type === "ExportSpecifier" && s.local.type === "Identifier" ? [s.local.name] : []));
          for (const name of names) if (!only || only.has(name)) exported.push({ name, file });
        }
      }
    };
    await visit(entry);

    for (const { name, file } of exported) {
      if (!/^[A-Z]/.test(name) || components.some((c) => c.name === name && c.import === pkg)) continue;
      const props = types.get(name) && callableProps(types.get(name)!);
      const variants: Record<string, string[]> = {};
      for (const member of props ? typeMembers(props, types, 0) : []) {
        const key = propertyKey(member.key);
        const type = member.typeAnnotation?.typeAnnotation;
        const values = key && type ? literalUnion(type, types, 0) : undefined;
        if (key && values && values.length > 1) variants[key] = [...new Set(values)];
      }
      const kebab = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      components.push({
        name,
        // One file can declare many components (bundled index.d.ts); the name keeps each contract apart.
        source: `${path.relative(root, file).split(path.sep).join("/")}#${name}`,
        import: pkg,
        exports: [name],
        variants: Object.keys(variants).length ? { [name]: variants } : {},
        defaults: {},
        controls: {},
        replaces: DEFAULT_REPLACES[kebab] ?? [],
      });
    }
  }
  return components;
}

function collectTypes(decl: Node, types: Map<string, Node>): void {
  if ((decl.type === "TSInterfaceDeclaration" || decl.type === "TSTypeAliasDeclaration") && decl.id.type === "Identifier") types.set(decl.id.name, decl);
  else if (decl.type === "TSDeclareFunction" && decl.id) types.set(decl.id.name, decl);
  else if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations) if (d.id.type === "Identifier") types.set(d.id.name, d);
  }
}

function declaredNames(decl: Node): string[] {
  if ((decl.type === "TSDeclareFunction" || decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) return [decl.id.name];
  if (decl.type === "VariableDeclaration") return decl.declarations.flatMap((d) => (d.id.type === "Identifier" ? [d.id.name] : []));
  return [];
}

function exportName(node: Node): string {
  return node.type === "Identifier" ? node.name : node.type === "StringLiteral" ? node.value : "";
}

/** The package folder, looking in node_modules up the tree (hoisted installs). */
function findPackage(root: string, name: string): string | undefined {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

async function typesEntry(dir: string): Promise<string | undefined> {
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const rootExport = (pkg.exports as Record<string, unknown> | undefined)?.["."];
  const fromExports =
    rootExport && typeof rootExport === "object"
      ? ((rootExport as Record<string, unknown>).types ?? ((rootExport as Record<string, Record<string, unknown>>).import ?? {}).types)
      : undefined;
  const candidates = [pkg.types, pkg.typings, fromExports, "index.d.ts", "dist/index.d.ts"].filter((c): c is string => typeof c === "string");
  return candidates.map((c) => path.join(dir, c)).find((file) => existsSync(file));
}

function resolveDeclaration(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from), specifier).replace(/\.[mc]?js$/, "");
  return [`${base}.d.ts`, `${base}.d.mts`, `${base}/index.d.ts`, base].find((file) => existsSync(file) && file.endsWith(".ts"));
}
