import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Expression, Node, ObjectExpression, Statement, TSPropertySignature } from "@babel/types";
import { glob } from "tinyglobby";
import { type Config, isReactNative } from "../config.js";
import { classStringsIn, tokenizeClasses, utilityFamily } from "../check/classes.js";
import { parseCode, propertyKey } from "../source.js";
import type { ComponentSpec } from "../spec.js";

/** Native elements a component replaces, keyed by shadcn file name. */
const DEFAULT_REPLACES: Record<string, string[]> = {
  button: ["button"],
  input: ["input"],
  textarea: ["textarea"],
  select: ["select"],
  "native-select": ["select"],
  label: ["label"],
  table: ["table"],
  separator: ["hr"],
  checkbox: ["input[type=checkbox]"],
  "radio-group": ["input[type=radio]"],
  slider: ["input[type=range]"],
  progress: ["progress"],
  dialog: ["dialog"],
};

/** React Native primitives a component replaces, keyed by file name. `module:Name` matches `import { Name } from "module"`. */
const NATIVE_REPLACES: Record<string, string[]> = {
  button: ["react-native:Button"],
  touchable: ["react-native:TouchableOpacity", "react-native:TouchableHighlight", "react-native:TouchableWithoutFeedback", "react-native:Pressable"],
  pressable: ["react-native:TouchableOpacity", "react-native:TouchableHighlight", "react-native:TouchableWithoutFeedback", "react-native:Pressable"],
  text: ["react-native:Text"],
  "text-input": ["react-native:TextInput"],
  "text-field": ["react-native:TextInput"],
  input: ["react-native:TextInput"],
  switch: ["react-native:Switch"],
  spinner: ["react-native:ActivityIndicator"],
};

const PLATFORM_SUFFIX = /\.(ios|android|web|native)$/;

interface CvaDefinition {
  variants: Record<string, string[]>;
  defaults: Record<string, string>;
  controls: Record<string, string[]>;
  optionClasses: Record<string, Record<string, string[]>>;
}

/** Builds component contracts from every file in the UI directory, reading variants from `cva()` calls. */
export async function extractComponents(root: string, config: Config): Promise<Omit<ComponentSpec, "body">[]> {
  if (!existsSync(path.join(root, config.uiDir))) return [];
  const allFiles = (await glob(`${config.uiDir}/**/*.{tsx,jsx,ts,js}`, { cwd: root, ignore: config.exclude })).sort();
  // `button.ios.tsx` / `button.android.tsx` are one component: prefer `button.tsx`, else the first platform file.
  const files: string[] = [];
  const seen = new Set<string>();
  const stem = (f: string) => f.replace(/\.[^.]+$/, "").replace(PLATFORM_SUFFIX, "");
  for (const file of [...allFiles].sort((a, b) => Number(PLATFORM_SUFFIX.test(a.replace(/\.[^.]+$/, ""))) - Number(PLATFORM_SUFFIX.test(b.replace(/\.[^.]+$/, ""))))) {
    if (seen.has(stem(file))) continue;
    seen.add(stem(file));
    files.push(file);
  }
  files.sort();
  const replacesByName = isReactNative(config) ? NATIVE_REPLACES : DEFAULT_REPLACES;
  const subpathImports = await usesSubpathImports(root, config);
  const components: Omit<ComponentSpec, "body">[] = [];

  for (const file of files) {
    const code = await readFile(path.join(root, file), "utf8");
    let program: Statement[];
    try {
      program = parseCode(code, file).program.body;
    } catch {
      continue;
    }

    const cvas = new Map<string, CvaDefinition>();
    const declarations: Array<{ name: string; start: number; end: number; exported: boolean; fn?: Node }> = [];
    const exportedNames = new Set<string>();
    const types = new Map<string, Node>();

    for (const statement of program) {
      const exported = statement.type === "ExportNamedDeclaration";
      const decl = exported ? statement.declaration : statement;
      if ((decl?.type === "TSInterfaceDeclaration" || decl?.type === "TSTypeAliasDeclaration") && decl.id.type === "Identifier") {
        types.set(decl.id.name, decl);
      }
      if (statement.type === "ExportNamedDeclaration" && !statement.source) {
        for (const spec of statement.specifiers) {
          if (spec.type === "ExportSpecifier" && spec.local.type === "Identifier") exportedNames.add(spec.local.name);
        }
      }
      if (!decl) continue;
      if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
        declarations.push({ name: decl.id.name, start: decl.start!, end: decl.end!, exported, fn: decl });
      } else if (decl.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id.type !== "Identifier") continue;
          declarations.push({ name: d.id.name, start: d.start!, end: d.end!, exported, fn: d.init ? componentFunction(d.init) : undefined });
          const cva = d.init && readVariantFactory(d.init, code);
          if (cva) cvas.set(d.id.name, cva);
        }
      }
    }

    const exports: string[] = [];
    const variants: ComponentSpec["variants"] = {};
    const defaults: ComponentSpec["defaults"] = {};
    const controls: ComponentSpec["controls"] = {};
    const optionClasses: NonNullable<ComponentSpec["optionClasses"]> = {};
    for (const decl of declarations) {
      if (!decl.exported && !exportedNames.has(decl.name)) continue;
      exports.push(decl.name);
      const own = cvas.get(decl.name);
      const used = own ? [own] : [...cvas].filter(([name]) => new RegExp(`\\b${name}\\b`).test(code.slice(decl.start, decl.end))).map(([, c]) => c);
      if (used.length === 0) {
        // Without cva, read variants from string-literal union props: `variant?: "primary" | "ghost"`.
        const fromProps = decl.fn && /^[A-Z]/.test(decl.name) ? readPropVariants(decl.fn, types) : undefined;
        if (fromProps && Object.keys(fromProps.variants).length) {
          variants[decl.name] = fromProps.variants;
          if (Object.keys(fromProps.defaults).length) defaults[decl.name] = fromProps.defaults;
        }
        continue;
      }
      variants[decl.name] = Object.assign({}, ...used.map((c) => c.variants));
      const merged = Object.assign({}, ...used.map((c) => c.defaults));
      if (Object.keys(merged).length) defaults[decl.name] = merged;
      const controlled = Object.assign({}, ...used.map((c) => c.controls));
      if (Object.keys(controlled).length) controls[decl.name] = controlled;
      optionClasses[decl.name] = Object.assign({}, ...used.map((c) => c.optionClasses));
    }
    if (exports.length === 0) continue;

    const base = path.basename(file).replace(/\.[^.]+$/, "").replace(PLATFORM_SUFFIX, "");
    const relative = file.slice(config.uiDir.length + 1).replace(/\.[^.]+$/, "").replace(PLATFORM_SUFFIX, "").replace(/\/index$/, "");
    const name = pascalCase(base === "index" ? path.basename(path.dirname(file)) : base);
    // The component named after the file comes first; it's what agents should reach for.
    exports.sort((a, b) => Number(b === name) - Number(a === name));
    components.push({
      name,
      source: file,
      import: subpathImports ? `${config.uiImport}/${relative}` : config.uiImport,
      exports,
      variants,
      defaults,
      controls,
      optionClasses,
      replaces: replacesByName[base] ?? [],
    });
  }
  return components;
}

function readVariantFactory(init: Node, code: string): CvaDefinition | undefined {
  if (init.type !== "CallExpression" || init.callee.type !== "Identifier") return undefined;
  // cva(base, { variants }) or tailwind-variants tv({ base, slots, variants }).
  const options = (init.callee.name === "cva" ? init.arguments[1] : init.callee.name === "tv" ? init.arguments[0] : undefined) as Expression | undefined;
  if (init.callee.name !== "cva" && init.callee.name !== "tv") return undefined;
  if (options?.type !== "ObjectExpression") return { variants: {}, defaults: {}, controls: {}, optionClasses: {} };
  const variants: Record<string, string[]> = {};
  const defaults: Record<string, string> = {};
  const controls: Record<string, string[]> = {};
  const optionClasses: Record<string, Record<string, string[]>> = {};
  const variantsObject = objectProperty(options, "variants");
  if (variantsObject?.type === "ObjectExpression") {
    for (const prop of variantsObject.properties) {
      if (prop.type !== "ObjectProperty" || prop.value.type !== "ObjectExpression") continue;
      const key = propertyKey(prop.key);
      if (!key) continue;
      variants[key] = prop.value.properties.flatMap((p) => (p.type === "ObjectProperty" ? (propertyKey(p.key) ?? []) : []));
      const families = new Set(
        classStringsIn(prop.value, code)
          .flatMap((s) => tokenizeClasses(s))
          .flatMap((t) => utilityFamily(t.utility) ?? []),
      );
      if (families.size) controls[key] = [...families].sort();
      optionClasses[key] = {};
      for (const option of prop.value.properties) {
        const name = option.type === "ObjectProperty" ? propertyKey(option.key) : undefined;
        if (!name || option.type !== "ObjectProperty") continue;
        // Only unprefixed classes: `has-[>svg]:px-2.5` can't be expressed by a className override anyway.
        optionClasses[key][name] = classStringsIn(option.value, code)
          .flatMap((s) => tokenizeClasses(s))
          .filter((t) => t.raw === t.utility)
          .map((t) => t.raw);
      }
    }
  }
  const defaultsObject = objectProperty(options, "defaultVariants");
  if (defaultsObject?.type === "ObjectExpression") {
    for (const prop of defaultsObject.properties) {
      if (prop.type !== "ObjectProperty") continue;
      const key = propertyKey(prop.key);
      const value = prop.value;
      if (key && (value.type === "StringLiteral" || value.type === "BooleanLiteral" || value.type === "NumericLiteral")) {
        defaults[key] = String(value.value);
      }
    }
  }
  return { variants, defaults, controls, optionClasses };
}

/**
 * Whether components are imported one file at a time (`@/components/ui/button`) or from a barrel (`@acme/ui`).
 * Path aliases use subpaths; a package does when its `exports` lists more than the root entry.
 */
async function usesSubpathImports(root: string, config: Config): Promise<boolean> {
  if (/^[@~#]\//.test(config.uiImport) || config.uiImport.startsWith(".")) return true;
  for (let dir = path.resolve(root, config.uiDir); ; dir = path.dirname(dir)) {
    const pkgFile = path.join(dir, "package.json");
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(await readFile(pkgFile, "utf8")) as { name?: string; exports?: unknown };
      if (pkg.name === config.uiImport) {
        const keys = pkg.exports && typeof pkg.exports === "object" ? Object.keys(pkg.exports) : [];
        return keys.some((k) => k !== "." && k !== "./package.json");
      }
    }
    if (path.dirname(dir) === dir) return true;
  }
}

/** The function behind a component declaration, unwrapping `forwardRef(...)` / `memo(...)`. */
function componentFunction(init: Node): Node | undefined {
  if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") return init;
  if (init.type === "CallExpression") {
    const first = init.arguments[0];
    if (first) return componentFunction(first);
  }
  return undefined;
}

function readPropVariants(fn: Node, types: Map<string, Node>): { variants: Record<string, string[]>; defaults: Record<string, string> } {
  const variants: Record<string, string[]> = {};
  const defaults: Record<string, string> = {};
  if (fn.type !== "FunctionDeclaration" && fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") return { variants, defaults };
  const param = fn.params[0];
  if (!param) return { variants, defaults };
  const annotation = "typeAnnotation" in param && param.typeAnnotation?.type === "TSTypeAnnotation" ? param.typeAnnotation.typeAnnotation : undefined;
  for (const member of annotation ? typeMembers(annotation, types, 0) : []) {
    const key = propertyKey(member.key);
    const type = member.typeAnnotation?.typeAnnotation;
    const values = key && type ? literalUnion(type, types, 0) : undefined;
    if (key && values && values.length > 1) variants[key] = values;
  }
  if (param.type === "ObjectPattern") {
    for (const prop of param.properties) {
      if (prop.type !== "ObjectProperty" || prop.value.type !== "AssignmentPattern") continue;
      const key = propertyKey(prop.key);
      if (key && key in variants && prop.value.right.type === "StringLiteral") defaults[key] = prop.value.right.value;
    }
  }
  return { variants, defaults };
}

export function typeMembers(type: Node, types: Map<string, Node>, depth: number): TSPropertySignature[] {
  if (depth > 8) return [];
  if (type.type === "TSTypeLiteral") return type.members.filter((m): m is TSPropertySignature => m.type === "TSPropertySignature");
  if (type.type === "TSIntersectionType") return type.types.flatMap((t) => typeMembers(t, types, depth + 1));
  // `(Props & ClassProp) | undefined` in compiled declarations: the members of every branch.
  if (type.type === "TSUnionType") return type.types.flatMap((t) => typeMembers(t, types, depth + 1));
  if (type.type === "TSParenthesizedType") return typeMembers(type.typeAnnotation, types, depth + 1);
  if (type.type === "TSTypeReference" && type.typeName.type === "Identifier") {
    if (type.typeName.name === "VariantProps") return variantPropsMembers(type.typeArguments?.params[0], types, depth);
    const declared = types.get(type.typeName.name);
    if (declared?.type === "TSInterfaceDeclaration") {
      const own = declared.body.body.filter((m): m is TSPropertySignature => m.type === "TSPropertySignature");
      // `interface ButtonProps extends VariantProps<typeof buttonVariants>`
      const inherited = (declared.extends ?? []).flatMap((heritage) => {
        if (heritage.expression.type !== "Identifier") return [];
        if (heritage.expression.name === "VariantProps") return variantPropsMembers(heritage.typeArguments?.params[0], types, depth);
        const parent = types.get(heritage.expression.name);
        return parent ? typeMembers({ type: "TSTypeReference", typeName: heritage.expression } as Node, types, depth + 1) : [];
      });
      return [...own, ...inherited];
    }
    if (declared?.type === "TSTypeAliasDeclaration") return typeMembers(declared.typeAnnotation, types, depth + 1);
  }
  return [];
}

/** `VariantProps<typeof buttonVariants>`: the props of that variant function (a cva/tv call or its declared type). */
function variantPropsMembers(argument: Node | undefined, types: Map<string, Node>, depth: number): TSPropertySignature[] {
  if (argument?.type !== "TSTypeQuery" || argument.exprName.type !== "Identifier") return [];
  const target = types.get(argument.exprName.name);
  const props = target ? callableProps(target) : undefined;
  return props ? typeMembers(props, types, depth + 1) : [];
}

/** The first parameter's type of a declared function or function-typed constant. */
export function callableProps(node: Node): Node | undefined {
  const firstParam = (params: Node[]) => {
    const param = params[0];
    return param && "typeAnnotation" in param && param.typeAnnotation?.type === "TSTypeAnnotation" ? param.typeAnnotation.typeAnnotation : undefined;
  };
  if (node.type === "TSDeclareFunction" || node.type === "FunctionDeclaration") return firstParam(node.params);
  if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.typeAnnotation?.type === "TSTypeAnnotation") {
    const type = node.id.typeAnnotation.typeAnnotation;
    if (type.type === "TSFunctionType") return firstParam(type.params);
    // React.FC<Props>, ForwardRefExoticComponent<Props & RefAttributes<…>>, MemoExoticComponent<…>
    if (type.type === "TSTypeReference" && type.typeArguments?.params[0]) return type.typeArguments.params[0];
  }
  return undefined;
}


/** `"a" | "b"` (directly or through a local type alias) -> ["a", "b"]; anything else -> undefined. */
export function literalUnion(type: Node, types: Map<string, Node>, depth: number): string[] | undefined {
  if (depth > 5) return undefined;
  if (type.type === "TSLiteralType") return type.literal.type === "StringLiteral" ? [type.literal.value] : undefined;
  if (type.type === "TSUndefinedKeyword" || type.type === "TSNullKeyword") return [];
  if (type.type === "TSParenthesizedType") return literalUnion(type.typeAnnotation, types, depth + 1);
  if (type.type === "TSUnionType") {
    const values: string[] = [];
    for (const member of type.types) {
      const inner = literalUnion(member, types, depth + 1);
      if (!inner) return undefined;
      values.push(...inner);
    }
    return values;
  }
  if (type.type === "TSTypeReference" && type.typeName.type === "Identifier") {
    const declared = types.get(type.typeName.name);
    if (declared?.type === "TSTypeAliasDeclaration") return literalUnion(declared.typeAnnotation, types, depth + 1);
  }
  return undefined;
}

function objectProperty(object: ObjectExpression, name: string): Node | undefined {
  for (const prop of object.properties) {
    if (prop.type === "ObjectProperty" && propertyKey(prop.key) === name) return prop.value;
  }
  return undefined;
}

function pascalCase(name: string): string {
  return name.replace(/(^|[-_])(\w)/g, (_, __, c: string) => c.toUpperCase());
}
