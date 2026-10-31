import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Command, Option } from "commander";
import pc from "picocolors";
import { runCheck, writeBaseline } from "./check/index.js";
import { apply, archive, formatVerify, init, list, propose, sync } from "./commands.js";
import { explore, formatExplore, verifyProposal } from "./workflow.js";
import { AGENT_TOOLS, type AgentTool, agentLocation, detectTools, writeAgentFiles } from "./agents.js";
import { configJsonSchema, loadConfig, UserError } from "./config.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { exportScript, type FigmaExport, figmaDiff, figmaPushScript, parseExports } from "./figma.js";
import { doctor, formatDoctor } from "./doctor.js";
import { runFix } from "./fix.js";
import { serveMcp } from "./mcp.js";
import { repoPrefix } from "./git.js";
import { count, type Format, report, reportFigmaDiff, reportReview } from "./report.js";
import { loadSpec } from "./spec.js";
import { runReview } from "./review.js";
import { changesMarkdown, writePreview } from "./preview.js";
import { specAt } from "./workflow.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command()
  .name("designspec")
  .description("Spec-driven design systems: define tokens, components and rules once; AI agents follow them and CI enforces them.")
  .version(version)
  .option("-C, --cwd <dir>", "project root (default: the current directory)");

const root = () => program.opts<{ cwd?: string }>().cwd ?? process.cwd();

program
  .command("init")
  .description("detect the stack and create designspec.config.json, the design/ spec, agent skills and a baseline")
  .option("-f, --force", "overwrite an existing config")
  .option("--no-agents", "don't set up AI agents (AGENTS.md, skills, rules, MCP config)")
  .option("--tools <tools>", `AI tools to set up, comma-separated: ${AGENT_TOOLS.join(", ")} (default: Claude Code plus the ones the repo already uses)`)
  .option("--no-baseline", "don't record existing violations")
  .action((options: { force?: boolean; agents: boolean; baseline: boolean; tools?: string }) =>
    init(root(), { force: !!options.force, agents: options.agents, baseline: options.baseline, tools: parseTools(options.tools) }),
  );

program
  .command("agents")
  .description("set up or update AI agent instructions and MCP config without re-running init")
  .option("--tools <tools>", `comma-separated: ${AGENT_TOOLS.join(", ")} (default: Claude Code plus the ones the repo already uses)`)
  .action(async (options: { tools?: string }) => {
    const config = await loadConfig(root());
    const tools = parseTools(options.tools) ?? detectTools(agentLocation(root()).agentRoot);
    const written = await writeAgentFiles(root(), config, tools);
    console.log(`${pc.green("✔")} ${tools.join(", ")}: ${written.join(", ")}`);
  });

function parseTools(value: string | undefined): AgentTool[] | undefined {
  if (!value) return undefined;
  const tools = value.split(",").map((t) => t.trim().toLowerCase());
  const unknown = tools.filter((t) => !(AGENT_TOOLS as readonly string[]).includes(t));
  if (unknown.length) throw new UserError(`Unknown tool ${unknown.join(", ")}. Choose from: ${AGENT_TOOLS.join(", ")}.`);
  return tools as AgentTool[];
}

program
  .command("check")
  .description("check code against the design system")
  .argument("[paths...]", "files or directories to check (default: the whole project)")
  .option("--diff <base>", "only report problems on lines changed since <base> (e.g. origin/main)")
  .addOption(new Option("--format <format>", "output format").choices(["pretty", "json", "github", "markdown"]).default("pretty"))
  .addOption(new Option("--fail-on <level>", "exit with code 1 on").choices(["error", "warn", "never"]).default("error"))
  .option("--no-baseline", "report baselined violations too")
  .option("--update-baseline", "record all current violations as the new baseline")
  .action(async (paths: string[], options: { diff?: string; format: Format; failOn: "error" | "warn" | "never"; baseline: boolean; updateBaseline?: boolean }) => {
    if (options.updateBaseline) {
      const result = await runCheck({ root: root(), useBaseline: false });
      const recorded = await writeBaseline(root(), await loadConfig(root()), result.violations);
      console.log(`${pc.green("✔")} Baseline updated: ${recorded} violations recorded.`);
      return;
    }
    const result = await runCheck({ root: root(), paths, diffBase: options.diff, useBaseline: options.baseline });
    console.log(report(result, options.format, options.format === "github" || options.format === "markdown" ? repoPrefix(root()) : ""));
    const { errors, warnings } = count(result.violations);
    if ((options.failOn === "error" && errors > 0) || (options.failOn === "warn" && errors + warnings > 0)) process.exitCode = 1;
  });

program
  .command("fix")
  .description("rewrite exact variant overrides (px-3 py-2 → padding=\"compact\") and exact token colors (text-[#1a1a1a] → text-foreground)")
  .argument("[paths...]", "files or directories to fix (default: the whole project)")
  .option("--dry-run", "show what would change without writing files")
  .option("--colors", "also replace colors with tokens that have a dark mode (the color then adapts to the theme)")
  .action(async (paths: string[], options: { dryRun?: boolean; colors?: boolean }) => {
    const fixes = await runFix(root(), { paths, dryRun: options.dryRun, colors: options.colors });
    for (const fix of fixes) {
      console.log(pc.underline(fix.file));
      for (const change of fix.changes) console.log(`  ${change}`);
    }
    const count = fixes.reduce((n, f) => n + f.changes.length, 0);
    console.log(count ? `${pc.green("✔")} ${options.dryRun ? "Would fix" : "Fixed"} ${count} element${count === 1 ? "" : "s"} in ${fixes.length} file${fixes.length === 1 ? "" : "s"}.` : "Nothing to fix.");
  });

program
  .command("mcp")
  .description("run an MCP server (stdio) so AI agents can query components and tokens and check code")
  .action(() => serveMcp(root(), version));

program
  .command("review")
  .description("AI review of a PR diff against the design rules (needs ANTHROPIC_API_KEY); reports suggestions, never fails")
  .requiredOption("--diff <base>", "git ref to review changes against, e.g. origin/main")
  .addOption(new Option("--format <format>", "output format").choices(["pretty", "json", "github"]).default("pretty"))
  .option("--model <model>", "Claude model", "claude-opus-5-5")
  .addOption(new Option("--effort <effort>", "how hard the model thinks").choices(["low", "medium", "high"]).default("medium"))
  .action(async (options: { diff: string; format: Format; model: string; effort: "low" | "medium" | "high" }) => {
    const result = await runReview(root(), { diffBase: options.diff, model: options.model, effort: options.effort });
    console.log(reportReview(result, options.format, options.format === "github" ? repoPrefix(root()) : ""));
  });

program
  .command("schema", { hidden: true })
  .description("print the JSON Schema of designspec.config.json")
  .action(() => console.log(JSON.stringify(configJsonSchema(), null, 2)));

const figmaCommand = program.command("figma").description("compare and sync Figma variables with the spec (through the Figma MCP server)");

figmaCommand
  .command("export-script")
  .description("print a read-only Plugin API script that exports Figma variables; run it with the Figma MCP use_figma tool")
  .option("--collections <names>", "only these collections, comma-separated (for exports over use_figma's 48 KB limit)")
  .action((options: { collections?: string }) => console.log(exportScript(options.collections?.split(",").map((c) => c.trim()))));

figmaCommand
  .command("diff")
  .description("compare an export (the export script's result, saved as JSON) with the spec")
  .argument("<exports...>", "JSON files with the export script's results (several when exported per collection)")
  .addOption(new Option("--format <format>", "output format").choices(["pretty", "json", "markdown"]).default("pretty"))
  .action(async (files: string[], options: { format: "pretty" | "json" | "markdown" }) => {
    const config = await loadConfig(root());
    const diff = figmaDiff(await readExports(files), await loadSpec(root(), config), config);
    console.log(reportFigmaDiff(diff, options.format));
  });

figmaCommand
  .command("push-script")
  .description("print a Plugin API script that writes code values into Figma for the differences (review it before running)")
  .argument("<exports...>", "JSON files with the export script's results")
  .option("--tokens <names>", "only these tokens, comma-separated (e.g. --scrollbar-thumb,--ring)")
  .action(async (files: string[], options: { tokens?: string }) => {
    const config = await loadConfig(root());
    const exported = await readExports(files);
    const diff = figmaDiff(exported, await loadSpec(root(), config), config);
    const { script, steps } = figmaPushScript(exported, diff, options.tokens?.split(",").map((t) => t.trim()));
    if (steps.length === 0) {
      console.error("Nothing to push.");
      return;
    }
    console.log(script);
  });

async function readExports(files: string[]): Promise<FigmaExport> {
  try {
    return parseExports(await Promise.all(files.map((file) => readFile(path.resolve(root(), file), "utf8"))));
  } catch (error) {
    throw new UserError(`Could not read the Figma export: ${(error as Error).message}`);
  }
}

program
  .command("preview")
  .description("write one HTML page of the design system: every token drawn in each mode, every component with its variants")
  .option("-o, --out <file>", "where to write it (default: design/preview.html, git-ignored)")
  .option("--diff <base>", "mark what changed since <base> (e.g. origin/main)")
  .addOption(new Option("--format <format>", "html writes the page; markdown prints the changes since --diff as a PR comment section").choices(["html", "markdown"]).default("html"))
  .option("--url <url>", "with --format markdown: link to the published page")
  .option("--open", "open the page in the browser")
  .action(async (options: { out?: string; diff?: string; format: "html" | "markdown"; url?: string; open?: boolean }) => {
    if (options.format === "markdown") {
      if (!options.diff) throw new UserError("--format markdown shows changes: pass --diff <base>.");
      const config = await loadConfig(root());
      const markdown = changesMarkdown(await specAt(root(), config, options.diff), await loadSpec(root(), config), options.url);
      if (markdown) console.log(markdown);
      return;
    }
    const { file, changes } = await writePreview(root(), { out: options.out, base: options.diff });
    const shown = path.relative(process.cwd(), file);
    console.log(`${pc.green("✔")} ${shown.startsWith("..") ? file : shown}${changes === undefined ? "" : ` (${changes} change${changes === 1 ? "" : "s"} since ${options.diff})`}`);
    if (options.open) openFile(file);
  });

function openFile(file: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

program
  .command("doctor")
  .description("show what designspec checks in this project, what it doesn't, and why")
  .option("--json", "output JSON")
  .action(async (options: { json?: boolean }) => {
    const result = await doctor(root());
    console.log(options.json ? JSON.stringify(result, null, 2) : formatDoctor(result));
  });

program
  .command("explore")
  .description("map the design system and where code works around it: hotspots, repeated overrides and values")
  .option("--json", "output JSON")
  .action(async (options: { json?: boolean }) => {
    const result = await explore(root());
    console.log(options.json ? JSON.stringify(result, null, 2) : formatExplore(result));
  });

program
  .command("apply")
  .description("after changing the code for a proposal: sync the spec, migrate overrides, tick tasks and verify")
  .argument("<name>", "proposal name")
  .action(async (name: string) => {
    const result = await apply(root(), name);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("verify")
  .description("check a proposal against the code: declared changes implemented, nothing undeclared, tasks done")
  .argument("<name>", "proposal name")
  .option("--diff <base>", "git ref with the spec before the change (default: origin/main or main)")
  .option("--json", "output JSON")
  .action(async (name: string, options: { diff?: string; json?: boolean }) => {
    const result = await verifyProposal(root(), name, options.diff);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatVerify(result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("sync")
  .description("update the spec (tokens.json, component frontmatter) from code")
  .action(() => sync(root()));

program
  .command("propose")
  .description("open a design system change proposal in design/changes/<name>")
  .argument("<name>", "kebab-case name, e.g. add-warning-color")
  .action((name: string) => propose(root(), name));

program
  .command("archive")
  .description("move an accepted proposal to design/archive")
  .argument("<name>", "proposal name")
  .action((name: string) => archive(root(), name));

program
  .command("list")
  .description("list open proposals")
  .action(() => list(root()));

program.parseAsync().catch((error: unknown) => {
  if (error instanceof UserError) {
    console.error(`${pc.red("✖")} ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 2;
});
