import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { glob } from "tinyglobby";
import { type Config, loadConfig, ruleSetting } from "../config.js";
import { diffSpec, extractSpec } from "../extract/index.js";
import { cssImportClosure } from "../extract/tokens.js";
import { CoverageCollector, type NotChecked } from "../coverage.js";
import { STYLESHEET } from "../stylesheets.js";
import { checkCss } from "./css.js";
import { parseSfc, type SfcStyle } from "./sfc.js";
import { collectStyledTemplates } from "./styled.js";
import { scanDefinedVars } from "./token-refs.js";
import { diffAgainst, type GitDiff } from "../git.js";
import { parseCode, SourceText } from "../source.js";
import { loadSpec, type Spec, specPaths } from "../spec.js";
import { collectClassStrings } from "./classes.js";
import { collectImports } from "./imports.js";
import { FILE_RULES, PROJECT_RULES } from "./rules/index.js";
import type { Violation } from "./types.js";

export interface CheckOptions {
  root: string;
  /** Only check these files or globs. */
  paths?: string[];
  /** Only report problems on lines changed relative to this git ref. */
  diffBase?: string;
  useBaseline?: boolean;
}

export interface CheckResult {
  violations: Violation[];
  filesChecked: number;
  baselined: number;
  /** What designspec couldn't check (in a diff: only what the change touches). */
  notChecked: NotChecked[];
}

const IGNORE_FILE = /designspec-ignore-file/;
const IGNORE_NEXT_LINE = /designspec-ignore-next-line(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?/;
const IGNORE_LINE = /designspec-ignore-line(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?/;
// `eslint-disable-next-line acme/design-tokens -- reason`: rule list ends at `--`, `*/` or end of line.
const ESLINT_NEXT_LINE = /eslint-disable-next-line\b([^\n]*?)(?:\s--|\*\/|$)/;
const ESLINT_LINE = /eslint-disable-line\b([^\n]*?)(?:\s--|\*\/|$)/;
const ESLINT_FILE = /\/\*\s*eslint-disable(?!-)\b([^*]*?)(?:\s--[^*]*)?\*\//;

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const { root } = options;
  const config = await loadConfig(root);
  const spec = await loadSpec(root, config);
  const diff = options.diffBase ? diffAgainst(root, options.diffBase) : undefined;
  const files = await resolveFiles(root, config, options.paths, diff);

  let fileViolations: Violation[] = [];
  const project = await projectContext(root, config);
  for (const file of files) fileViolations.push(...(await checkFile(root, file, config, spec, project)));
  if (diff) fileViolations = fileViolations.filter((v) => isAddedLine(diff, v));

  let baselined = 0;
  if (options.useBaseline !== false) {
    const baseline = await readBaseline(root, config);
    fileViolations = fileViolations.filter((v) => {
      const key = fingerprint(v);
      const remaining = baseline.get(key) ?? 0;
      if (remaining <= 0) return true;
      baseline.set(key, remaining - 1);
      baselined++;
      return false;
    });
  }

  const violations = [...(await projectViolations(root, config, spec, diff)), ...fileViolations];
  const notChecked = project.coverage.result(diff ? new Set(diff.changed) : undefined);
  return { violations, filesChecked: files.length, baselined, notChecked };
}

export async function resolveFiles(root: string, config: Config, paths: string[] | undefined, diff: GitDiff | undefined): Promise<string[]> {
  const included = picomatch(config.include);
  const excluded = picomatch(config.exclude);
  const accept = (file: string) => included(file) && !excluded(file);
  if (diff) return [...diff.added.keys()].filter((f) => accept(f) && existsSync(path.join(root, f))).sort();
  if (paths?.length) {
    const patterns = paths.map((p) => (existsSync(path.join(root, p)) && !/\.[a-z]+$/i.test(p) ? `${p.replace(/\/$/, "")}/**/*` : p));
    return (await glob(patterns, { cwd: root, ignore: config.exclude })).filter(accept).sort();
  }
  return (await glob(config.include, { cwd: root, ignore: config.exclude })).sort();
}

export async function checkFile(root: string, file: string, config: Config, spec: Spec, project?: ProjectContext): Promise<Violation[]> {
  return checkSource(file, await readFile(path.join(root, file), "utf8"), config, spec, project);
}

/** Checks code that may not exist on disk yet, e.g. a snippet an agent is about to write. `file` decides the parser and path-based rules. */
/** Facts about the whole project that single-file checks need. */
export interface ProjectContext {
  /** Token CSS files and what they @import; they define values rather than consume them. */
  tokenSources: Set<string>;
  definedVars: Set<string>;
  coverage: CoverageCollector;
}

export async function projectContext(root: string, config: Config): Promise<ProjectContext> {
  const tokenSources = new Set(await cssImportClosure(root, config.cssFiles));
  const definedVars = new Set<string>();
  const coverage = new CoverageCollector();
  for (const file of [...(await glob(config.include, { cwd: root, ignore: config.exclude })), ...tokenSources]) {
    try {
      const text = await readFile(path.join(root, file), "utf8");
      for (const name of scanDefinedVars(text)) definedVars.add(name);
      coverage.addSource(file, text);
    } catch {
      // unreadable files are skipped here and reported by the check itself
    }
  }
  await coverage.addFileTypes(root, config);
  return { tokenSources, definedVars, coverage };
}

export function checkSource(file: string, text: string, config: Config, spec: Spec, project?: ProjectContext): Violation[] {
  // Token sources define the raw values everything else must reference.
  if (IGNORE_FILE.test(text.slice(0, 500)) || config.themeFiles.includes(file) || config.cssFiles.includes(file) || project?.tokenSources.has(file)) return [];
  const source = new SourceText(text);
  const definedVars = new Set([...(project?.definedVars ?? []), ...scanDefinedVars(text)]);
  if (STYLESHEET.test(file)) return filterIgnored(checkCss(file, text, config, spec, definedVars), source, text, config);
  let ast: ReturnType<typeof parseCode>;
  let componentStyles: SfcStyle[] = [];
  try {
    if (/\.(vue|svelte)$/.test(file)) {
      const sfc = parseSfc(text, file);
      ast = sfc.ast;
      componentStyles = sfc.styles;
    } else {
      ast = parseCode(text, file);
    }
  } catch (error) {
    const loc = (error as { loc?: { line: number; column: number } }).loc;
    return [{ rule: "parse-error", severity: "warn", file, line: loc?.line ?? 1, column: (loc?.column ?? 0) + 1, message: `Could not parse file: ${(error as Error).message}` }];
  }

  const inUiDir = file.startsWith(`${config.uiDir}/`);
  const classStrings = collectClassStrings(ast, text, config.classFunctions);
  const imports = collectImports(ast);
  const violations: Violation[] = [];

  for (const rule of FILE_RULES) {
    const { level, options } = ruleSetting(config, rule.id, rule.defaultLevel);
    if (level === "off" || (inUiDir && !rule.runsInUiDir) || (rule.enabled && !rule.enabled(config))) continue;
    const ignore = options.ignore as string[] | undefined;
    if (ignore?.length && picomatch(ignore)(file)) continue;
    rule.check({
      file,
      source,
      ast,
      config,
      spec,
      options,
      classStrings,
      imports,
      definedVars,
      report(index, message, suggestion) {
        const { line, column } = source.position(index);
        violations.push({ rule: rule.id, severity: level, file, line, column, message, suggestion });
      },
    });
  }

  // CSS in styled-components / Emotion templates.
  for (const template of collectStyledTemplates(ast, imports)) {
    violations.push(...checkCss(file, template.css, config, spec, definedVars, { source, toSource: template.toSource, skipColors: inUiDir }));
  }
  // <style> blocks and style="…" attributes of Vue / Svelte components.
  for (const style of componentStyles) {
    violations.push(...checkCss(file, style.css, config, spec, definedVars, { source, toSource: style.toSource, skipColors: inUiDir, lang: style.lang }));
  }

  return filterIgnored(violations, source, text, config);
}

function filterIgnored(violations: Violation[], source: SourceText, text: string, config: Config): Violation[] {
  const eslintFileRules = config.eslintAliases && Object.keys(config.eslintAliases).length ? ESLINT_FILE.exec(text.slice(0, 1000))?.[1] : undefined;
  return violations
    .filter((v) => !isIgnored(source, v, config.eslintAliases) && !(eslintFileRules !== undefined && eslintCovers(eslintFileRules, v.rule, config.eslintAliases)))
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

function isIgnored(source: SourceText, violation: Violation, eslintAliases: Record<string, string[]>): boolean {
  const line = source.lines[violation.line - 1];
  const previous = source.lines[violation.line - 2];
  const matches = (regex: RegExp, text: string | undefined) => {
    const match = text !== undefined ? regex.exec(text) : null;
    if (!match) return false;
    return !match[1] || match[1].split(/\s*,\s*/).includes(violation.rule);
  };
  if (matches(IGNORE_LINE, line) || matches(IGNORE_NEXT_LINE, previous)) return true;
  if (!eslintAliases || Object.keys(eslintAliases).length === 0) return false;
  const eslint = (regex: RegExp, text: string | undefined) => {
    const match = text !== undefined ? regex.exec(text) : null;
    return match !== null && eslintCovers(match[1], violation.rule, eslintAliases);
  };
  return eslint(ESLINT_LINE, line) || eslint(ESLINT_NEXT_LINE, previous);
}

/** Whether an eslint-disable rule list covers a designspec rule; an empty list disables everything, as in ESLint. */
function eslintCovers(ruleList: string, rule: string, eslintAliases: Record<string, string[]>): boolean {
  const eslintRules = ruleList.split(",").map((r) => r.trim()).filter(Boolean);
  if (eslintRules.length === 0) return true;
  return eslintRules.some((r) => eslintAliases[r]?.includes(rule) || eslintAliases[r]?.includes("*"));
}

function isAddedLine(diff: GitDiff, violation: Violation): boolean {
  const lines = diff.added.get(violation.file);
  return lines === "all" || (lines !== undefined && lines.has(violation.line));
}

async function projectViolations(root: string, config: Config, spec: Spec, diff: GitDiff | undefined): Promise<Violation[]> {
  const violations: Violation[] = [];
  const at = (rule: keyof typeof PROJECT_RULES, file: string, message: string, suggestion: string) => {
    const { level } = ruleSetting(config, rule, PROJECT_RULES[rule].defaultLevel);
    if (level !== "off") violations.push({ rule, severity: level, file, line: 1, column: 1, message, suggestion });
  };

  for (const item of diffSpec(await extractSpec(root, config), spec, config.specDir)) {
    at("spec-drift", item.file, item.message, "Run `designspec sync` and commit the updated spec.");
  }

  if (diff) {
    // Design system sources: changing them is a design decision. The spec alone follows from them (`sync`),
    // and hand edits to it are caught by spec-drift, so spec-only changes (e.g. after an upgrade) need no proposal.
    const tokenFiles = config.tokenFiles.map((entry) => (typeof entry === "string" ? entry : entry.path));
    const sources = [...(await cssImportClosure(root, config.cssFiles)), ...config.themeFiles, ...tokenFiles, ...(config.tailwindConfig ? [config.tailwindConfig] : [])];
    const watched = picomatch([`${config.uiDir}/**`, ...sources]);
    // A proposal is a folder (`changes/<name>/...`); loose files like `changes/.gitkeep` don't count.
    const proposalFile = new RegExp(`^${escapeRegExp(config.specDir)}/(changes|archive)/[^/]+/`);
    const hasProposal = diff.changed.some((f) => proposalFile.test(f));
    // The PR that adopts designspec creates the whole spec; that's setup, not a design system change.
    const adopting = !diff.existedAtBase(`${config.specDir}/tokens.json`) && !diff.existedAtBase(`${config.specDir}/components`);
    const touched = [...new Set(diff.changed.filter((f) => watched(f)))].sort((a, b) => Number(b.startsWith(`${config.specDir}/`)) - Number(a.startsWith(`${config.specDir}/`)));
    if (!hasProposal && !adopting && touched.length) {
      // One problem per PR, anchored on the first code file: GitHub shows at most 10 error annotations per step.
      const listed = touched.slice(0, 5).join(", ") + (touched.length > 5 ? ` and ${touched.length - 5} more` : "");
      at("require-proposal", touched[0], `Design system changed without a proposal (${listed}).`, `Run \`designspec propose <name>\` and describe the change in ${config.specDir}/changes/<name>/proposal.md.`);
    }
  }
  return violations;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Line-number independent identity of a violation, so unrelated edits don't invalidate the baseline. */
function fingerprint(violation: Violation): string {
  return createHash("sha1").update(`${violation.rule}|${violation.file}|${violation.message}`).digest("hex").slice(0, 16);
}

async function readBaseline(root: string, config: Config): Promise<Map<string, number>> {
  const file = specPaths(root, config).baseline;
  if (!existsSync(file)) return new Map();
  const json = JSON.parse(await readFile(file, "utf8")) as { entries?: Record<string, number> };
  return new Map(Object.entries(json.entries ?? {}));
}

/** Records current file-level violations so they don't fail future checks. */
export async function writeBaseline(root: string, config: Config, violations: Violation[]): Promise<number> {
  const entries: Record<string, number> = {};
  let count = 0;
  for (const violation of violations) {
    if (violation.rule in PROJECT_RULES) continue;
    const key = fingerprint(violation);
    entries[key] = (entries[key] ?? 0) + 1;
    count++;
  }
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(specPaths(root, config).baseline, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
  return count;
}
