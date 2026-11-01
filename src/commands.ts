import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { projectContext, runCheck, writeBaseline } from "./check/index.js";
import { CONFIG_FILE, type Config, DEFAULT_CONFIG, loadConfig, UserError, writeConfig } from "./config.js";
import { type AgentTool, agentLocation, detectTools, writeAgentFiles } from "./agents.js";
import { detect } from "./detect.js";
import { runFix } from "./fix.js";
import { type VerifyResult, verifyProposal } from "./workflow.js";
import { diffSpec, extractSpec, mergeSpec } from "./extract/index.js";
import { loadSpec, specPaths, writeSpec } from "./spec.js";
import { type ProposalSections, proposalTemplate, RULES_MD, SPEC_README, TASKS_TEMPLATE } from "./templates.js";

const ok = (message: string) => console.log(`${pc.green("✔")} ${message}`);

export async function init(root: string, options: { force: boolean; agents: boolean; baseline: boolean; tools?: AgentTool[] }): Promise<void> {
  if (existsSync(path.join(root, CONFIG_FILE)) && !options.force) {
    throw new UserError(`${CONFIG_FILE} already exists. Use --force to re-initialize, or "designspec sync" to refresh the spec.`);
  }

  const found = await detect(root);
  const presets: Config["presets"] = [
    found.framework === "react-native" ? "react-native" : "react",
    ...(found.tailwind ? ([`tailwind-v${found.tailwind}`] as const) : []),
    ...(found.shadcn ? (["shadcn"] as const) : []),
    ...found.componentLibraries,
    ...found.headless,
  ];
  // With --force, detected fields are refreshed and everything you configured (rules, zones…) is kept.
  // Keep what the user wrote, not the defaults filled in when loading: new defaults should reach them.
  const previous = existsSync(path.join(root, CONFIG_FILE)) ? await loadConfig(root).then(() => readRawConfig(root)).catch(() => undefined) : undefined;
  const { $schema: _, ...kept } = previous ?? {};
  const stored: Partial<Config> = {
    rules: {},
    ...kept,
    presets,
    uiDir: found.uiDir,
    uiImport: found.uiImport,
    cssFiles: found.cssFiles,
    ...(found.themeFiles.length ? { themeFiles: found.themeFiles } : {}),
    ...(found.tokenFiles.length ? { tokenFiles: found.tokenFiles } : {}),
    ...(found.tailwindConfig ? { tailwindConfig: found.tailwindConfig } : {}),
  };
  await writeConfig(root, stored);
  const config: Config = { ...DEFAULT_CONFIG, ...stored };

  const framework = { next: "Next.js", react: "React", "react-native": "React Native" }[found.framework ?? "react"] ?? "No React framework";
  const stack = [found.framework ? framework : "No React framework", found.tailwind && `Tailwind v${found.tailwind}`].filter(Boolean);
  ok(stack.join(" + "));

  const paths = specPaths(root, config);
  const spec = mergeSpec(await extractSpec(root, config), await loadSpec(root, config));
  await writeSpec(root, config, spec);
  const variantCount = spec.components.reduce((n, c) => n + Object.values(c.variants).reduce((m, v) => m + Object.values(v).reduce((k, o) => k + o.length, 0), 0), 0);
  ok(`${found.shadcn ? "shadcn/ui" : "UI components"} (${config.uiDir}): ${plural(spec.components.length, "component")}, ${plural(variantCount, "variant value")}`);
  if (found.headless.length) ok(`Headless: ${found.headless.join(", ")} (allowed only inside ${config.uiDir})`);
  const tokenSources = [...config.tokenFiles.map((f) => (typeof f === "string" ? f : f.path)), ...config.cssFiles, ...(config.tailwindConfig ? [config.tailwindConfig] : []), ...config.themeFiles];
  ok(`${plural(spec.tokens.length, "token")}${tokenSources.length ? ` from ${tokenSources.join(", ")}` : " (no token source found; set cssFiles or themeFiles in the config)"}`);

  await writeIfMissing(path.join(paths.dir, "README.md"), SPEC_README(config.specDir));
  await writeIfMissing(path.join(paths.dir, "rules.md"), RULES_MD);
  await mkdir(paths.changes, { recursive: true });
  await writeIfMissing(path.join(paths.changes, ".gitkeep"), "");

  if (options.agents) {
    const tools = options.tools ?? detectTools(agentLocation(root).agentRoot);
    const written = await writeAgentFiles(root, config, tools);
    ok(`AI agents (${tools.join(", ")}): ${written.join(", ")}`);
  }


  if (options.baseline) {
    const result = await runCheck({ root, useBaseline: false });
    const recorded = await writeBaseline(root, config, result.violations);
    ok(`Baseline: ${recorded} existing violations recorded in ${config.specDir}/baseline.json (they won't fail checks)`);
  }

  const notChecked = (await projectContext(root, config)).coverage.result();
  for (const n of notChecked) {
    console.log(`${pc.yellow("⚠")} Not checked: ${n.what} (${plural(n.files.length, "file")}): ${n.reason}`);
  }

  console.log(`\n${pc.bold("Next:")} review ${config.specDir}/, then add the GitHub Action (see README) and commit.`);
}

export async function sync(root: string): Promise<void> {
  const config = await loadConfig(root);
  const previous = await loadSpec(root, config);
  const extracted = await extractSpec(root, config);
  const drift = diffSpec(extracted, previous, config.specDir);
  if (drift.length === 0) {
    ok("Spec is already in sync with code.");
    return;
  }
  const { removed } = await writeSpec(root, config, mergeSpec(extracted, previous));
  for (const item of drift) console.log(`  ${pc.dim("•")} ${item.message}`);
  if (removed.length) console.log(`  ${pc.dim("•")} Removed ${removed.map((f) => `${config.specDir}/components/${f}`).join(", ")}`);
  ok(`Updated ${config.specDir}/ (${drift.length} change${drift.length === 1 ? "" : "s"}).`);
  const changes = await activeChanges(root, config);
  if (changes.length === 0) console.log(pc.yellow(`  No open proposal. If token sources or components changed, pull requests need one: run "designspec propose <name>".`));
}

export async function propose(root: string, name: string): Promise<void> {
  const dir = await createProposal(root, name);
  ok(`Created ${dir}/proposal.md and tasks.md`);
}

/** Creates `changes/<name>/` without logging (the MCP server talks over stdout). Returns the project-relative folder. */
export async function createProposal(root: string, name: string, sections?: ProposalSections): Promise<string> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new UserError(`Proposal name must be kebab-case, e.g. "add-warning-color". Got "${name}".`);
  const config = await loadConfig(root);
  const dir = path.join(specPaths(root, config).changes, name);
  if (existsSync(dir)) throw new UserError(`${projectPath(root, dir)} already exists.`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "proposal.md"), proposalTemplate(name, sections));
  await writeFile(path.join(dir, "tasks.md"), TASKS_TEMPLATE);
  return projectPath(root, dir);
}

/**
 * After the code change: update the spec from code, migrate overrides the change makes unnecessary, tick the
 * tasks it did, and verify the proposal.
 */
export async function apply(root: string, name: string): Promise<VerifyResult> {
  const config = await loadConfig(root);
  const dir = path.join(specPaths(root, config).changes, name);
  if (!existsSync(dir)) throw new UserError(`No open proposal named "${name}". Run "designspec list" to see open proposals.`);
  await sync(root);
  const fixes = await runFix(root, {});
  const fixed = fixes.reduce((n, f) => n + f.changes.length, 0);
  if (fixed) ok(`Migrated ${fixed} className override${fixed === 1 ? "" : "s"} to variants in ${fixes.length} file${fixes.length === 1 ? "" : "s"}`);
  const tasksFile = path.join(dir, "tasks.md");
  if (existsSync(tasksFile)) {
    const tasks = await readFile(tasksFile, "utf8");
    await writeFile(tasksFile, tasks.replace(/- \[ \] (Run `npx designspec(?:-kit)? (?:apply|sync)[^\n]*)/g, "- [x] $1"));
  }
  const result = await verifyProposal(root, name);
  console.log(formatVerify(result));
  return result;
}

export function formatVerify(result: VerifyResult): string {
  const lines = [
    ...result.implemented.map((i) => `  ${pc.green("✔")} ${i}`),
    ...result.missing.map((i) => `  ${pc.red("✖")} ${i} ${pc.dim("(declared, not in code)")}`),
    ...result.undeclared.map((i) => `  ${pc.yellow("⚠")} ${i} ${pc.dim("(in code, not in the proposal)")}`),
    `  ${result.tasks.done === result.tasks.total ? pc.green("✔") : pc.yellow("○")} tasks ${result.tasks.done}/${result.tasks.total}`,
  ];
  const verdict = result.ok
    ? `${pc.green("✔")} ${result.name} matches the code. Archive it once merged: designspec archive ${result.name}`
    : `${pc.red("✖")} ${result.name} doesn't match the code yet.`;
  return [...lines, verdict].join("\n");
}

export async function archive(root: string, name: string): Promise<void> {
  const config = await loadConfig(root);
  const paths = specPaths(root, config);
  const from = path.join(paths.changes, name);
  if (!existsSync(from)) throw new UserError(`No open proposal named "${name}". Run "designspec list" to see open proposals.`);
  const drift = diffSpec(await extractSpec(root, config), await loadSpec(root, config), config.specDir);
  if (drift.length) throw new UserError(`The spec is out of sync with code (${drift.length} differences). Run "designspec sync" before archiving.`);
  const to = path.join(paths.archive, `${new Date().toISOString().slice(0, 10)}-${name}`);
  await mkdir(paths.archive, { recursive: true });
  await rename(from, to);
  ok(`Archived to ${projectPath(root, to)}`);
}

export async function list(root: string): Promise<void> {
  const config = await loadConfig(root);
  const changes = await activeChanges(root, config);
  if (changes.length === 0) {
    console.log("No open proposals.");
    return;
  }
  for (const name of changes) {
    const tasksFile = path.join(specPaths(root, config).changes, name, "tasks.md");
    const tasks = existsSync(tasksFile) ? await readFile(tasksFile, "utf8") : "";
    const done = (tasks.match(/- \[x\]/gi) ?? []).length;
    const total = done + (tasks.match(/- \[ \]/g) ?? []).length;
    console.log(`  ${name}  ${pc.dim(total ? `${done}/${total} tasks` : "")}`);
  }
}

async function activeChanges(root: string, config: Config): Promise<string[]> {
  const dir = specPaths(root, config).changes;
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
}

async function readRawConfig(root: string): Promise<Partial<Config> & { $schema?: string }> {
  return JSON.parse(await readFile(path.join(root, CONFIG_FILE), "utf8"));
}

/** Project-relative path with `/` on every platform, as everywhere else in designspec. */
function projectPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  if (!existsSync(file)) await writeFileEnsuringDir(file, content);
}

async function writeFileEnsuringDir(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}


