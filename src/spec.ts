import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { Config } from "./config.js";

export type TokenType = "color" | "dimension" | "other";

export interface Token {
  name: string;
  type: TokenType;
  value: string;
  cssVar?: string;
  /** Tailwind utility suffix, e.g. `primary` for `bg-primary`. */
  utility?: string;
  /** How code references the token when it lives in JS, e.g. `spacing.md`. */
  code?: string;
  /** The theme module defining a JS token; read from code when needed, never written to the spec. */
  source?: string;
  modes?: Record<string, string>;
}

export interface ComponentSpec {
  name: string;
  source: string;
  import: string;
  exports: string[];
  /** Variant props per export, e.g. `{ Button: { variant: ["default", "outline"] } }`. */
  variants: Record<string, Record<string, string[]>>;
  defaults: Record<string, Record<string, string>>;
  /** Utility families each variant prop sets, e.g. `{ Button: { size: ["height", "padding"] } }`; className must not override them. */
  controls: Record<string, Record<string, string[]>>;
  /** Native elements this component replaces, e.g. `button` or `input[type=checkbox]`. */
  replaces: string[];
  /**
   * Plain classes behind each variant option, e.g. `{ Panel: { padding: { compact: ["px-3", "py-2"] } } }`.
   * Read from code when needed (by `designspec fix`); never written to the spec.
   */
  optionClasses?: Record<string, Record<string, Record<string, string[]>>>;
  body: string;
}

export interface Spec {
  tokens: Token[];
  components: ComponentSpec[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const EXTENSION_KEY = "designspec";

export function specPaths(root: string, config: Config) {
  const dir = path.join(root, config.specDir);
  return {
    dir,
    tokens: path.join(dir, "tokens.json"),
    components: path.join(dir, "components"),
    changes: path.join(dir, "changes"),
    archive: path.join(dir, "archive"),
    baseline: path.join(dir, "baseline.json"),
  };
}

export async function loadSpec(root: string, config: Config): Promise<Spec> {
  const paths = specPaths(root, config);
  const tokens = existsSync(paths.tokens) ? fromDtcg(JSON.parse(await readFile(paths.tokens, "utf8"))) : [];
  const components: ComponentSpec[] = [];
  if (existsSync(paths.components)) {
    for (const file of (await readdir(paths.components)).filter((f) => f.endsWith(".md")).sort()) {
      const component = parseComponent(await readFile(path.join(paths.components, file), "utf8"));
      if (component) components.push(component);
    }
  }
  return { tokens, components };
}

export async function writeSpec(root: string, config: Config, spec: Spec): Promise<{ removed: string[] }> {
  const paths = specPaths(root, config);
  await mkdir(paths.components, { recursive: true });
  await writeFile(paths.tokens, `${JSON.stringify(toDtcg(spec.tokens), null, 2)}\n`);

  const keep = new Set<string>();
  for (const component of spec.components) {
    const file = componentFileName(component);
    keep.add(file);
    await writeFile(path.join(paths.components, file), serializeComponent(component));
  }
  const removed: string[] = [];
  for (const file of await readdir(paths.components)) {
    if (file.endsWith(".md") && !keep.has(file)) {
      await rm(path.join(paths.components, file));
      removed.push(file);
    }
  }
  return { removed };
}

export function componentFileName(component: ComponentSpec): string {
  // Package components (`…/index.d.ts#Button`) share declaration files and may share names with local ones:
  // name them after the package and the component (`acme-kit-button.md`).
  if (component.source.includes("#")) {
    const pkg = component.import.replace(/^@/, "").replace(/[^\w]+/g, "-");
    return `${pkg}-${component.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}.md`;
  }
  return `${path.basename(component.source).replace(/\.[^.]+$/, "")}.md`;
}

export function parseComponent(text: string): ComponentSpec | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const data = (YAML.parse(match[1]) ?? {}) as Partial<ComponentSpec>;
  return {
    name: String(data.name ?? ""),
    source: String(data.source ?? ""),
    import: String(data.import ?? ""),
    exports: data.exports ?? [],
    variants: data.variants ?? {},
    defaults: data.defaults ?? {},
    controls: data.controls ?? {},
    replaces: data.replaces ?? [],
    body: text.slice(match[0].length),
  };
}

export function serializeComponent(component: ComponentSpec): string {
  const data: Record<string, unknown> = {
    name: component.name,
    source: component.source,
    import: component.import,
    exports: component.exports,
  };
  if (Object.keys(component.variants).length) data.variants = component.variants;
  if (Object.keys(component.defaults).length) data.defaults = component.defaults;
  if (Object.keys(component.controls).length) data.controls = component.controls;
  if (component.replaces.length) data.replaces = component.replaces;

  const doc = new YAML.Document(data, { aliasDuplicateObjects: false });
  YAML.visit(doc, {
    Seq(_, node) {
      node.flow = true;
    },
  });
  return `---\n${doc.toString({ lineWidth: 0 })}---\n${component.body}`;
}

/** Tokens as W3C Design Tokens (DTCG) JSON, grouped by type. */
export function toDtcg(tokens: Token[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const token of tokens) {
    const group = (out[token.type] ??= {});
    const extension: Record<string, unknown> = {};
    if (token.cssVar) extension.cssVar = token.cssVar;
    if (token.utility) extension.utility = token.utility;
    if (token.code) extension.code = token.code;
    if (token.modes && Object.keys(token.modes).length) extension.modes = token.modes;
    group[token.name] = {
      ...(token.type === "other" ? {} : { $type: token.type }),
      $value: token.value,
      ...(Object.keys(extension).length ? { $extensions: { [EXTENSION_KEY]: extension } } : {}),
    };
  }
  return out;
}

export function fromDtcg(json: Record<string, Record<string, Record<string, unknown>>>): Token[] {
  const tokens: Token[] = [];
  for (const [group, entries] of Object.entries(json)) {
    if (group.startsWith("$") || typeof entries !== "object") continue;
    for (const [name, entry] of Object.entries(entries)) {
      if (name.startsWith("$") || typeof entry !== "object" || entry === null || !("$value" in entry)) continue;
      const extension = ((entry.$extensions as Record<string, unknown> | undefined)?.[EXTENSION_KEY] ?? {}) as Partial<Token>;
      const type = (entry.$type as TokenType | undefined) ?? (group as TokenType);
      tokens.push({
        name,
        type: type === "color" || type === "dimension" ? type : "other",
        value: String(entry.$value),
        cssVar: extension.cssVar,
        utility: extension.utility,
        code: extension.code,
        modes: extension.modes,
      });
    }
  }
  return tokens;
}
