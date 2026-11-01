import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { projectContext } from "./check/index.js";
import { FILE_RULES, PROJECT_RULES } from "./check/rules/index.js";
import { type Adoption, formatAdoption, measureAdoption } from "./adoption.js";
import { loadConfig, ruleSetting } from "./config.js";
import type { NotChecked } from "./coverage.js";
import { repoPrefix } from "./git.js";
import { loadSpec } from "./spec.js";
import { AGENTS_START } from "./templates.js";

export interface DoctorReport {
  adoption: Adoption;
  presets: string[];
  tokens: Record<string, number>;
  components: number;
  variantValues: number;
  rules: Array<{ id: string; level: string; why?: string }>;
  agents: { agentsMd: boolean; skills: string[]; mcpServer?: string };
  notChecked: NotChecked[];
}

/** What designspec checks in this project, what it doesn't, and why. */
export async function doctor(root: string): Promise<DoctorReport> {
  const config = await loadConfig(root);
  const spec = await loadSpec(root, config);
  const project = await projectContext(root, config);

  const tokens: Record<string, number> = {};
  for (const t of spec.tokens) tokens[t.type] = (tokens[t.type] ?? 0) + 1;
  const variantValues = spec.components.reduce((n, c) => n + Object.values(c.variants[c.name] ?? Object.values(c.variants)[0] ?? {}).flat().length, 0);

  const rules: DoctorReport["rules"] = [];
  for (const rule of FILE_RULES) {
    const { level } = ruleSetting(config, rule.id, rule.defaultLevel);
    const idle = level !== "off" ? rule.idleReason?.(spec) : undefined;
    if (level !== "off" && rule.enabled && !rule.enabled(config)) rules.push({ id: rule.id, level: "inactive", why: `needs ${rule.needs ?? "a preset"}` });
    else if (idle) rules.push({ id: rule.id, level: "idle", why: idle });
    else rules.push({ id: rule.id, level });
  }
  for (const [id, rule] of Object.entries(PROJECT_RULES)) {
    const { level } = ruleSetting(config, id, rule.defaultLevel);
    rules.push({ id, level, ...(id === "require-proposal" ? { why: "on pull requests (--diff)" } : {}) });
  }

  // Skills and .mcp.json live at the git root in a monorepo.
  const prefix = repoPrefix(root).replace(/\/$/, "");
  const agentRoot = prefix ? path.resolve(root, ...prefix.split("/").map(() => "..")) : root;
  const agentsFile = path.join(root, "AGENTS.md");
  const agentsMd = existsSync(agentsFile) && (await readFile(agentsFile, "utf8")).includes(AGENTS_START);
  const skills = ["designspec-ui", "designspec-propose", "designspec-figma"].filter((s) => existsSync(path.join(agentRoot, ".claude/skills", s, "SKILL.md")));
  let mcpServer: string | undefined;
  try {
    const servers = JSON.parse(await readFile(path.join(agentRoot, ".mcp.json"), "utf8")).mcpServers ?? {};
    const ours = Object.keys(servers).filter((name) => JSON.stringify(servers[name]).includes("designspec"));
    // In a monorepo each app has its own entry (`-C apps/web`).
    mcpServer = prefix ? ours.find((name) => (servers[name].args ?? []).includes(prefix)) : ours[0];
  } catch {
    // no .mcp.json
  }

  return {
    adoption: await measureAdoption(root, config, spec),
    presets: config.presets,
    tokens,
    components: spec.components.length,
    variantValues,
    rules,
    agents: { agentsMd, skills, mcpServer },
    notChecked: project.coverage.result(),
  };
}

export function formatDoctor(report: DoctorReport): string {
  const yes = pc.green("✔");
  const no = pc.yellow("○");
  const tokenSummary = Object.entries(report.tokens).map(([type, n]) => `${n} ${type}`).join(", ") || "none";
  const lines = [
    `${pc.bold("Stack")}       ${report.presets.join(", ")}`,
    `${pc.bold("Spec")}        ${tokenSummary} tokens · ${report.components} components (${report.variantValues} variant values)`,
    "",
    formatAdoption(report.adoption),
    "",
    pc.bold("Rules"),
    ...report.rules.map((r) => {
      const active = r.level === "error" || r.level === "warn";
      return `  ${active ? yes : no} ${r.id.padEnd(22)} ${active ? r.level : pc.dim(r.level)}${r.why ? pc.dim(`  ${r.why}`) : ""}`;
    }),
    "",
    pc.bold("AI agents"),
    `  ${report.agents.agentsMd ? yes : no} AGENTS.md section`,
    `  ${report.agents.skills.length ? yes : no} skills ${report.agents.skills.join(", ") || pc.dim("(run designspec init)")}`,
    `  ${report.agents.mcpServer ? yes : no} MCP server ${report.agents.mcpServer ?? pc.dim("(not in .mcp.json)")}`,
    "",
    pc.bold("Not checked"),
    ...(report.notChecked.length
      ? report.notChecked.map((n) => `  ${pc.yellow("⚠")} ${n.what} (${n.files.length} file${n.files.length === 1 ? "" : "s"}): ${n.reason}`)
      : [`  ${yes} Everything designspec found is checked`]),
  ];
  return lines.join("\n");
}
