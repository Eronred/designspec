import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { repoPrefix } from "./git.js";
import { AGENTS_END, AGENTS_START, agentsBlock, figmaSkill, proposeSkill, uiSkill } from "./templates.js";

export const AGENT_TOOLS = ["claude", "cursor", "copilot", "gemini", "windsurf"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

const UI_GLOBS = "**/*.{tsx,jsx,ts,js,vue,svelte,css,scss,less}";

/** Where agents start: the git root in a monorepo, else the project. Plus the MCP server name and its -C path. */
export function agentLocation(root: string): { agentRoot: string; serverName: string; projectDir: string } {
  const projectDir = repoPrefix(root).replace(/\/$/, "");
  return {
    agentRoot: projectDir ? path.resolve(root, ...projectDir.split("/").map(() => "..")) : root,
    serverName: projectDir ? `designspec-${projectDir.split("/").pop()}` : "designspec",
    projectDir,
  };
}

/** Tools the repository already uses, plus Claude Code. Every agent also reads AGENTS.md. */
export function detectTools(agentRoot: string): AgentTool[] {
  const has = (p: string) => existsSync(path.join(agentRoot, p));
  return [
    "claude",
    ...(has(".cursor") ? (["cursor"] as const) : []),
    ...(has(".vscode") || has(".github/copilot-instructions.md") ? (["copilot"] as const) : []),
    ...(has(".gemini") || has("GEMINI.md") ? (["gemini"] as const) : []),
    ...(has(".windsurf") ? (["windsurf"] as const) : []),
  ];
}

/** Writes each tool's instructions and MCP config, keeping everything else in shared files. Returns what it wrote. */
export async function writeAgentFiles(root: string, config: Config, tools: readonly AgentTool[]): Promise<string[]> {
  const { agentRoot, serverName, projectDir } = agentLocation(root);
  const command = { command: "npx", args: ["-y", "designspec-cli", ...(projectDir ? ["-C", projectDir] : []), "mcp"] };
  const written: string[] = [];
  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    written.push(path.relative(agentRoot, file).split(path.sep).join("/") || file);
  };
  const upsertBlock = async (file: string, block: string, heading: string) => {
    await write(file, replaceBlock(existsSync(file) ? await readFile(file, "utf8") : "", block, heading));
  };
  const upsertServer = async (file: string, key: "mcpServers" | "servers", entry: Record<string, unknown>) => {
    let json: Record<string, Record<string, unknown>> = {};
    if (existsSync(file)) {
      try {
        json = JSON.parse(await readFile(file, "utf8"));
      } catch {
        return; // don't overwrite a file we can't parse (e.g. JSON with comments)
      }
    }
    json[key] = { ...json[key], [serverName]: entry };
    await write(file, `${JSON.stringify(json, null, 2)}\n`);
  };

  // Every agent (Codex, OpenCode, Cursor, Copilot…) reads AGENTS.md next to the code.
  await upsertBlock(path.join(root, "AGENTS.md"), agentsBlock(config.specDir, config.uiImport), "# Agent instructions");
  const instructions = withoutFrontmatter(uiSkill());

  for (const tool of tools) {
    if (tool === "claude") {
      await write(path.join(agentRoot, ".claude/skills/designspec-ui/SKILL.md"), uiSkill());
      await write(path.join(agentRoot, ".claude/skills/designspec-propose/SKILL.md"), proposeSkill());
      await write(path.join(agentRoot, ".claude/skills/designspec-figma/SKILL.md"), figmaSkill());
      await upsertServer(path.join(agentRoot, ".mcp.json"), "mcpServers", command);
    } else if (tool === "cursor") {
      await write(
        path.join(agentRoot, ".cursor/rules/designspec.mdc"),
        `---\ndescription: Design system rules (designspec): use the spec's tokens and components when building UI\nglobs: ${UI_GLOBS}\nalwaysApply: false\n---\n${instructions}`,
      );
      await upsertServer(path.join(agentRoot, ".cursor/mcp.json"), "mcpServers", { type: "stdio", ...command });
    } else if (tool === "copilot") {
      await upsertBlock(path.join(agentRoot, ".github/copilot-instructions.md"), `${AGENTS_START}\n${instructions.trim()}\n${AGENTS_END}`, "# Copilot instructions");
      await upsertServer(path.join(agentRoot, ".vscode/mcp.json"), "servers", { type: "stdio", ...command });
    } else if (tool === "gemini") {
      await upsertBlock(path.join(agentRoot, "GEMINI.md"), `${AGENTS_START}\n${instructions.trim()}\n${AGENTS_END}`, "# Gemini instructions");
      await upsertServer(path.join(agentRoot, ".gemini/settings.json"), "mcpServers", command);
    } else if (tool === "windsurf") {
      await write(path.join(agentRoot, ".windsurf/rules/designspec.md"), `---\ntrigger: glob\nglobs: "${UI_GLOBS}"\n---\n${instructions}`);
    }
  }
  return written;
}

function withoutFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Adds or replaces the designspec section between its markers, leaving the rest of the file alone. */
export function replaceBlock(current: string, block: string, heading: string): string {
  const start = current.indexOf(AGENTS_START);
  const end = current.indexOf(AGENTS_END);
  if (start >= 0 && end > start) return current.slice(0, start) + block + current.slice(end + AGENTS_END.length);
  return current ? `${current.trimEnd()}\n\n${block}\n` : `${heading}\n\n${block}\n`;
}
