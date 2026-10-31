import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { type Adoption, formatAdoption, measureAdoption } from "./adoption.js";
import { runCheck } from "./check/index.js";
import { type Config, loadConfig, UserError } from "./config.js";
import { extractSpec } from "./extract/index.js";
import { fromDtcg, loadSpec, parseComponent, type Spec, specPaths } from "./spec.js";

/** What a proposal says will change, from the YAML front matter of proposal.md. */
export interface Delta {
  tokens: { add: string[]; change: string[]; remove: string[] };
  components: { add: string[]; remove: string[] };
  /** "Panel.padding" → values added / removed */
  variants: Record<string, { add: string[]; remove: string[] }>;
}

/** One change to the design system between two specs, with the key a delta uses for it. */
export interface SpecChange {
  kind: "token-add" | "token-change" | "token-remove" | "component-add" | "component-remove" | "variant-add" | "variant-remove";
  /** `--primary`, `Toast`, `Panel.padding=compact` */
  key: string;
}

export interface VerifyResult {
  name: string;
  /** Delta items found in code. */
  implemented: string[];
  /** Delta items not found in code. */
  missing: string[];
  /** Design system changes the delta doesn't mention. */
  undeclared: string[];
  tasks: { done: number; total: number };
  ok: boolean;
}

const EMPTY_DELTA: Delta = { tokens: { add: [], change: [], remove: [] }, components: { add: [], remove: [] }, variants: {} };

export function parseDelta(proposal: string): Delta {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(proposal)?.[1];
  if (!front) return structuredClone(EMPTY_DELTA);
  const data = (YAML.parse(front) ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)]);
  const variants: Delta["variants"] = {};
  for (const [key, value] of Object.entries(data.variants ?? {})) {
    const v = (value ?? {}) as Record<string, unknown>;
    variants[key] = { add: list(v.add), remove: list(v.remove) };
  }
  return {
    tokens: { add: list(data.tokens?.add), change: list(data.tokens?.change), remove: list(data.tokens?.remove) },
    components: { add: list(data.components?.add), remove: list(data.components?.remove) },
    variants,
  };
}

/** Every token, component and variant value that differs between two specs. */
export function specChanges(before: Spec, after: Spec): SpecChange[] {
  const changes: SpecChange[] = [];
  const tokenKey = (t: Spec["tokens"][number]) => t.cssVar ?? t.code ?? t.name;
  const beforeTokens = new Map(before.tokens.map((t) => [tokenKey(t), t]));
  const afterTokens = new Map(after.tokens.map((t) => [tokenKey(t), t]));
  for (const [key, token] of afterTokens) {
    const old = beforeTokens.get(key);
    if (!old) changes.push({ kind: "token-add", key });
    else if (old.value !== token.value || JSON.stringify(old.modes ?? {}) !== JSON.stringify(token.modes ?? {})) changes.push({ kind: "token-change", key });
  }
  for (const key of beforeTokens.keys()) if (!afterTokens.has(key)) changes.push({ kind: "token-remove", key });

  const beforeComponents = new Map(before.components.map((c) => [c.name, c]));
  const afterComponents = new Map(after.components.map((c) => [c.name, c]));
  for (const [name, component] of afterComponents) {
    const old = beforeComponents.get(name);
    if (!old) {
      changes.push({ kind: "component-add", key: name });
      continue;
    }
    const now = component.variants[name] ?? {};
    const was = old.variants[name] ?? {};
    for (const prop of new Set([...Object.keys(now), ...Object.keys(was)])) {
      for (const value of now[prop] ?? []) if (!(was[prop] ?? []).includes(value)) changes.push({ kind: "variant-add", key: `${name}.${prop}=${value}` });
      for (const value of was[prop] ?? []) if (!(now[prop] ?? []).includes(value)) changes.push({ kind: "variant-remove", key: `${name}.${prop}=${value}` });
    }
  }
  for (const name of beforeComponents.keys()) if (!afterComponents.has(name)) changes.push({ kind: "component-remove", key: name });
  return changes;
}

/** The delta's items, in the keys `specChanges` uses. */
function deltaItems(delta: Delta): SpecChange[] {
  return [
    ...delta.tokens.add.map((key) => ({ kind: "token-add" as const, key })),
    ...delta.tokens.change.map((key) => ({ kind: "token-change" as const, key })),
    ...delta.tokens.remove.map((key) => ({ kind: "token-remove" as const, key })),
    ...delta.components.add.map((key) => ({ kind: "component-add" as const, key })),
    ...delta.components.remove.map((key) => ({ kind: "component-remove" as const, key })),
    ...Object.entries(delta.variants).flatMap(([target, v]) => [
      ...v.add.map((value) => ({ kind: "variant-add" as const, key: `${target}=${value}` })),
      ...v.remove.map((value) => ({ kind: "variant-remove" as const, key: `${target}=${value}` })),
    ]),
  ];
}

/** Tokens can be named by CSS variable, code reference or name: `--warning`, `$warning`, `warning`. */
function sameItem(a: SpecChange, b: SpecChange): boolean {
  if (a.kind !== b.kind) return false;
  const norm = (k: string) => k.replace(/^(--|\$|@)/, "");
  return a.key === b.key || norm(a.key) === norm(b.key);
}

/**
 * Checks a proposal against the code: every change it declares is implemented, nothing else in the design
 * system changed, and its tasks are done. `base` is a git ref whose spec is the "before" (a PR's base);
 * without it, the spec on disk is.
 */
export async function verifyProposal(root: string, name: string, base?: string): Promise<VerifyResult> {
  const config = await loadConfig(root);
  const paths = specPaths(root, config);
  const dir = path.join(paths.changes, name);
  if (!existsSync(dir)) throw new UserError(`No open proposal named "${name}". Run "designspec list" to see open proposals.`);
  const delta = parseDelta(await readFile(path.join(dir, "proposal.md"), "utf8"));
  // "Before" is the spec where the branch started, so it still works after `sync` updated the spec on disk.
  const ref = base ?? defaultBase(root);
  const before = ref ? await specAt(root, config, ref) : await loadSpec(root, config);
  const after = await extractSpec(root, config);
  const changes = specChanges(before, after);
  const items = deltaItems(delta);

  const implemented = items.filter((item) => changes.some((c) => sameItem(c, item))).map(label);
  const missing = items.filter((item) => !changes.some((c) => sameItem(c, item))).map(label);
  const undeclared = changes.filter((c) => !items.some((item) => sameItem(c, item))).map(label);

  const tasksFile = path.join(dir, "tasks.md");
  const tasks = existsSync(tasksFile) ? await readFile(tasksFile, "utf8") : "";
  const done = (tasks.match(/- \[x\]/gi) ?? []).length;
  const total = done + (tasks.match(/- \[ \]/g) ?? []).length;
  return { name, implemented, missing, undeclared, tasks: { done, total }, ok: missing.length === 0 && undeclared.length === 0 && done === total };
}

function label(change: SpecChange): string {
  const verb = change.kind.split("-")[1];
  const what = change.kind.split("-")[0];
  return `${what} ${verb}: ${change.key}`;
}

/** The branch a change is made against: origin/main, main, origin/master or master, if any exists. */
export function defaultBase(root: string): string | undefined {
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, stdio: "ignore" });
      return ref;
    } catch {
      // not there
    }
  }
  return undefined;
}

/** The spec as committed at a git ref (the merge base with it, as a PR sees it). */
export async function specAt(root: string, config: Config, ref: string): Promise<Spec> {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const mergeBase = git(["merge-base", ref, "HEAD"]).trim();
  const show = (file: string) => {
    try {
      return git(["show", `${mergeBase}:./${config.specDir}/${file}`]);
    } catch {
      return undefined;
    }
  };
  const tokensJson = show("tokens.json");
  let componentFiles: string[] = [];
  try {
    componentFiles = git(["ls-tree", "--name-only", mergeBase, `./${config.specDir}/components/`]).split("\n").filter((f) => f.endsWith(".md"));
  } catch {
    // no components at that commit
  }
  const components = componentFiles.flatMap((file) => {
    const parsed = parseComponent(show(`components/${path.basename(file)}`) ?? "");
    return parsed ? [parsed] : [];
  });
  return { tokens: tokensJson ? fromDtcg(JSON.parse(tokensJson)) : [], components };
}

export interface ExploreResult {
  adoption: Adoption;
  tokens: number;
  components: number;
  proposals: string[];
  violations: Record<string, number>;
  /** Files with the most problems. */
  hotspots: Array<{ file: string; problems: number }>;
  /** The same className override on the same component, again and again: a missing variant. */
  repeatedOverrides: Array<{ pattern: string; count: number }>;
  /** The same hardcoded color or arbitrary value, again and again: a missing token. */
  repeatedValues: Array<{ value: string; rule: string; count: number }>;
}

/** A map of the design system and where code works around it, to decide what to propose. */
export async function explore(root: string): Promise<ExploreResult> {
  const config = await loadConfig(root);
  const spec = await loadSpec(root, config);
  const { violations } = await runCheck({ root, useBaseline: false });
  const count = <T extends string>(keys: T[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<T, number>());
  const top = <T extends string>(map: Map<T, number>, n: number) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);

  const byRule = count(violations.map((v) => v.rule));
  const byFile = count(violations.map((v) => v.file));
  // "px-3" overrides the padding that Panel's padding variant controls → group per component and file+line.
  const overridesByElement = new Map<string, string[]>();
  for (const v of violations.filter((v) => v.rule === "no-variant-override")) {
    const match = /^"([^"]+)" overrides the \w+ that (\w+)'s (\w+) variant/.exec(v.message);
    if (!match) continue;
    const key = `${v.file}:${v.line}|${match[2]}.${match[3]}`;
    overridesByElement.set(key, [...(overridesByElement.get(key) ?? []), match[1]]);
  }
  // One element per line is the common case; the same class twice on a line counts once.
  const overridePatterns = count([...overridesByElement].map(([key, classes]) => `${key.split("|")[1]}: ${[...new Set(classes)].sort().join(" ")}`));
  const values = count(
    violations
      .filter((v) => v.rule === "no-hardcoded-color" || v.rule === "no-arbitrary-value" || v.rule === "no-raw-style-value")
      .map((v) => `${v.rule}|${(/"([^"]+)"/.exec(v.message)?.[1] ?? v.message).toLowerCase()}`),
  );
  const proposalsDir = specPaths(root, config).changes;
  const proposals = existsSync(proposalsDir) ? (await readdir(proposalsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name) : [];

  return {
    adoption: await measureAdoption(root, config, spec, violations),
    tokens: spec.tokens.length,
    components: spec.components.length,
    proposals,
    violations: Object.fromEntries(top(byRule, 50)),
    hotspots: top(byFile, 10).map(([file, problems]) => ({ file, problems })),
    repeatedOverrides: top(overridePatterns, 10).filter(([, n]) => n > 1).map(([pattern, n]) => ({ pattern, count: n })),
    repeatedValues: top(values, 10)
      .filter(([, n]) => n > 1)
      .map(([key, n]) => ({ rule: key.split("|")[0], value: key.split("|").slice(1).join("|"), count: n })),
  };
}

export function formatExplore(result: ExploreResult): string {
  const lines = [
    formatAdoption(result.adoption),
    `Spec: ${result.tokens} tokens, ${result.components} components${result.proposals.length ? ` · open proposals: ${result.proposals.join(", ")}` : ""}`,
    "",
    "Problems by rule (incl. baselined):",
    ...Object.entries(result.violations).map(([rule, n]) => `  ${String(n).padStart(5)}  ${rule}`),
  ];
  if (result.hotspots.length) lines.push("", "Hotspots:", ...result.hotspots.map((h) => `  ${String(h.problems).padStart(5)}  ${h.file}`));
  if (result.repeatedOverrides.length) {
    lines.push("", "Repeated overrides (a missing variant?):", ...result.repeatedOverrides.map((o) => `  ${String(o.count).padStart(5)}× ${o.pattern}`));
  }
  if (result.repeatedValues.length) {
    lines.push("", "Repeated values (a missing token?):", ...result.repeatedValues.map((v) => `  ${String(v.count).padStart(5)}× ${v.value}  (${v.rule})`));
  }
  if (result.repeatedOverrides.length || result.repeatedValues.length) lines.push("", "Turn one into a proposal: designspec propose <name>");
  return lines.join("\n");
}
