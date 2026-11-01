import type { Config } from "../config.js";
import type { ComponentSpec, Spec, Token } from "../spec.js";
import { componentBody } from "../templates.js";
import { extractComponents } from "./components.js";
import { extractPackageComponents } from "./packages.js";
import { readTailwindConfig } from "./tailwind-config.js";
import { extractThemeTokens } from "./theme-files.js";
import { extractTokenFiles } from "./token-files.js";
import { extractTokens } from "./tokens.js";

/** Reads the design system as it currently exists in code. */
export async function extractSpec(root: string, config: Config): Promise<Spec> {
  const tailwind = config.tailwindConfig ? await readTailwindConfig(root, config.tailwindConfig) : undefined;
  const [cssTokens, themeTokens, fileTokens, components] = await Promise.all([
    extractTokens(root, config.cssFiles, tailwind?.utilities),
    extractThemeTokens(root, config.themeFiles),
    extractTokenFiles(root, config.tokenFiles),
    Promise.all([extractComponents(root, config), extractPackageComponents(root, config)]).then(([local, packaged]) => [...local, ...packaged]),
  ]);
  // Token files are the source when CSS is generated from them: their token wins, keeping the CSS token's utility.
  const fromFiles = new Map(fileTokens.map((t) => [t.cssVar, t]));
  const css = cssTokens.filter((t) => {
    const source = t.cssVar ? fromFiles.get(t.cssVar) : undefined;
    if (source && t.utility) source.utility ??= t.utility;
    return !source;
  });
  return {
    tokens: [...fileTokens, ...css, ...(tailwind?.tokens ?? []), ...themeTokens],
    components: components.map((c) => ({ ...c, body: componentBody(c) })),
  };
}

/** Combines freshly extracted values with the hand-written parts of the existing spec (docs, `replaces`). */
export function mergeSpec(extracted: Spec, previous: Spec): Spec {
  const { pairs } = pairComponents(extracted.components, previous.components);
  return {
    tokens: extracted.tokens,
    components: pairs.map(([c, prev]) => (prev ? { ...c, body: prev.body, replaces: prev.replaces } : c)),
  };
}

/**
 * Pairs each component in code with its spec entry: the same source file, or the same name when the file
 * moved (into a workspace package, say). `removed` are spec entries left without a component.
 */
function pairComponents<C extends { name: string; source: string }, S extends { name: string; source: string }>(
  code: C[],
  spec: S[],
): { pairs: [C, S | undefined][]; removed: S[] } {
  const bySource = new Map(spec.map((c) => [c.source, c]));
  const codeSources = new Set(code.map((c) => c.source));
  const byName = new Map(spec.filter((c) => !codeSources.has(c.source)).map((c) => [c.name, c]));
  const used = new Set<S>();
  const pairs = code.map((c): [C, S | undefined] => {
    const prev = bySource.get(c.source) ?? byName.get(c.name);
    if (prev && !used.has(prev)) {
      used.add(prev);
      return [c, prev];
    }
    return [c, undefined];
  });
  return { pairs, removed: spec.filter((c) => !used.has(c)) };
}

export interface DriftItem {
  file: string;
  message: string;
}

/** Differences between code and spec that `designspec sync` would write. */
export function diffSpec(extracted: Spec, spec: Spec, specDir: string): DriftItem[] {
  const items: DriftItem[] = [];
  const tokensFile = `${specDir}/tokens.json`;
  const key = (t: Token) => t.cssVar ?? t.code ?? t.name;
  const specTokens = new Map(spec.tokens.map((t) => [key(t), t]));
  const codeTokens = new Map(extracted.tokens.map((t) => [key(t), t]));

  for (const [k, token] of codeTokens) {
    const existing = specTokens.get(k);
    if (!existing) items.push({ file: tokensFile, message: `Token ${k} exists in code but not in the spec.` });
    else if (existing.value !== token.value || stable(existing.modes) !== stable(token.modes)) {
      items.push({ file: tokensFile, message: `Token ${k} changed in code (${existing.value} → ${token.value}).` });
    } else if (existing.type !== token.type) {
      items.push({ file: tokensFile, message: `Token ${k} changed type from ${existing.type} to ${token.type}.` });
    }
  }
  for (const k of specTokens.keys()) {
    if (!codeTokens.has(k)) items.push({ file: tokensFile, message: `Token ${k} is in the spec but no longer defined in code.` });
  }

  const { pairs, removed } = pairComponents(extracted.components, spec.components);
  for (const [component, existing] of pairs) {
    if (!existing) {
      items.push({ file: component.source, message: `Component ${component.name} is not registered in the spec.` });
    } else if (existing.source !== component.source) {
      items.push({ file: component.source, message: `Component ${component.name} moved from ${existing.source} to ${component.source}.` });
    } else if (stable(contract(existing)) !== stable(contract(component))) {
      items.push({ file: component.source, message: `Component ${component.name} changed (exports or variants) but its spec is out of date.` });
    }
  }
  for (const component of removed) {
    items.push({ file: `${specDir}/components/${component.source.split("/").pop()?.replace(/\.[^.]+$/, "")}.md`, message: `Component ${component.name} is in the spec but ${component.source} no longer exists.` });
  }
  return items;
}

function contract(c: ComponentSpec) {
  return { exports: [...c.exports].sort(), variants: c.variants, defaults: c.defaults, controls: c.controls };
}

/** JSON with sorted keys, for order-insensitive comparison. */
function stable(value: unknown): string {
  return JSON.stringify(value ?? null, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}
