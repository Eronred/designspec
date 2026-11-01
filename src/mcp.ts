import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkSource } from "./check/index.js";
import { FILE_RULES, PROJECT_RULES } from "./check/rules/index.js";
import { rankColorTokens } from "./color.js";
import { exportScript, figmaDiff, figmaPushScript, parseExports } from "./figma.js";
import { reportFigmaDiff } from "./report.js";
import { createProposal } from "./commands.js";
import { explore, formatExplore, verifyProposal } from "./workflow.js";
import { writePreview } from "./preview.js";
import { type Config, loadConfig, ruleSetting } from "./config.js";
import { allowedInZones } from "./zones.js";
import { loadSpec, serializeComponent, type Spec, specPaths, type Token } from "./spec.js";

const INSTRUCTIONS = `This project's design system. Before writing UI:
1. list_components / get_component to reuse existing components and their allowed variants.
2. find_tokens for colors, spacing and radii (pass a color to find the closest token).
3. check_code on the code you wrote; fix every error.
If nothing fits, call propose_change instead of inventing tokens, variants or components.`;

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (value: unknown): Text => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message: string): Text => ({ ...text(message), isError: true });

/** An MCP server exposing the spec in `root` to AI agents. */
export function createMcpServer(root: string, version: string): McpServer {
  const server = new McpServer({ name: "designspec", version }, { instructions: INSTRUCTIONS });
  // Read on every call so `designspec sync` and spec edits show up without a restart.
  const load = async (): Promise<{ config: Config; spec: Spec }> => {
    const config = await loadConfig(root);
    return { config, spec: await loadSpec(root, config) };
  };

  server.registerTool(
    "list_components",
    {
      description: "List design system components with their import path, exports, variants and the native elements they replace.",
      inputSchema: { query: z.string().optional().describe("Filter by name, e.g. 'button'") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const { spec } = await load();
      const q = query?.toLowerCase();
      return text(
        spec.components
          .filter((c) => !q || c.name.toLowerCase().includes(q) || c.exports.some((e) => e.toLowerCase().includes(q)))
          .map((c) => ({ name: c.name, import: c.import, exports: c.exports, variants: c.variants[c.name] ?? Object.values(c.variants)[0] ?? {}, replaces: c.replaces })),
      );
    },
  );

  server.registerTool(
    "get_component",
    {
      description: "Get a component's full contract (exports, variants, defaults, what variants control) and its usage docs.",
      inputSchema: { name: z.string().describe("Component name, e.g. 'Button'") },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const { spec } = await load();
      const component = spec.components.find((c) => c.name.toLowerCase() === name.toLowerCase() || c.exports.includes(name));
      if (!component) return failure(`No component "${name}". Available: ${spec.components.map((c) => c.name).join(", ")}`);
      return text(serializeComponent(component));
    },
  );

  server.registerTool(
    "find_tokens",
    {
      description: "Find design tokens by name, type, or closeness to a color value. Returns how to reference each token in code.",
      inputSchema: {
        query: z.string().optional().describe("Substring of the token name, e.g. 'muted' or 'radius'"),
        type: z.enum(["color", "dimension", "other"]).optional(),
        color: z.string().optional().describe("A color like '#e5484d' to find the closest color tokens"),
        file: z.string().optional().describe("The file you're editing; tokens not allowed in its zone are left out"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, type, color, file }) => {
      const { config, spec } = await load();
      const allowed = file ? spec.tokens.filter((t) => allowedInZones(t, file.replace(/^\.\//, ""), config)) : spec.tokens;
      if (color) {
        const ranked = rankColorTokens(color, allowed);
        if (ranked.length === 0) return failure(`"${color}" is not a color I can parse.`);
        return text(ranked.map(({ token, distance }) => ({ ...describe(token), distance: Math.round(distance * 10) / 10 })));
      }
      const q = query?.toLowerCase();
      const tokens = allowed.filter((t) => (!type || t.type === type) && (!q || t.name.toLowerCase().includes(q)));
      return text(tokens.slice(0, 50).map(describe));
    },
  );

  server.registerTool(
    "check_code",
    {
      description: "Check code against the design system before writing it. Returns the same problems CI would report.",
      inputSchema: {
        code: z.string().describe("The full file contents"),
        file: z.string().describe("Project-relative path the code will live at, e.g. 'app/settings/page.tsx'; decides parsing and path rules"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ code, file }) => {
      const { config, spec } = await load();
      const violations = checkSource(file.replace(/^\.\//, ""), code, config, spec);
      if (violations.length === 0) return text("No design system problems.");
      return text(violations.map((v) => `${v.line}:${v.column} ${v.severity} ${v.rule}: ${v.message}${v.suggestion ? ` Fix: ${v.suggestion}` : ""}`).join("\n"));
    },
  );

  server.registerTool(
    "get_rules",
    {
      description: "Get the design rules (plain language) and which automated checks are active.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { config } = await load();
      const rulesFile = path.join(specPaths(root, config).dir, "rules.md");
      const rules = existsSync(rulesFile) ? await readFile(rulesFile, "utf8") : "";
      const checks = [...FILE_RULES.map((r) => ({ id: r.id, description: r.description, level: ruleSetting(config, r.id, r.defaultLevel).level })), ...Object.entries(PROJECT_RULES).map(([id, r]) => ({ id, description: r.description, level: ruleSetting(config, id, r.defaultLevel).level }))];
      return text(`${rules}\n## Automated checks\n\n${checks.filter((c) => c.level !== "off").map((c) => `- ${c.id} (${c.level}): ${c.description}`).join("\n")}\n`);
    },
  );

  server.registerTool(
    "propose_change",
    {
      description: "Open a design system change proposal when no existing token, variant or component fits. Creates changes/<name>/proposal.md for a human to review.",
      inputSchema: {
        name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("kebab-case, e.g. 'add-warning-color'"),
        why: z.string().describe("The need the design system doesn't cover"),
        what: z.string().describe("The tokens, variants or components to add or change"),
        alternatives: z.string().optional().describe("Existing options considered and why they don't fit"),
        delta: z
          .string()
          .optional()
          .describe('Expected spec changes as YAML, checked by verify_proposal, e.g. "tokens:\\n  add: [--warning]\\nvariants:\\n  Panel.padding: { add: [compact] }"'),
      },
    },
    async ({ name, why, what, alternatives, delta }) => {
      try {
        const dir = await createProposal(root, name, { why, what, alternatives, delta });
        return text(`Created ${dir}/proposal.md and tasks.md. Implement the change, then run \`designspec sync\`. A design system owner reviews it in the PR.`);
      } catch (error) {
        return failure((error as Error).message);
      }
    },
  );

  server.registerTool(
    "explore_design_system",
    {
      description:
        "Map the design system and where code works around it: problems per rule, hotspot files, className overrides repeated on a component (a missing variant) and values repeated as hardcoded colors or arbitrary values (a missing token).",
      annotations: { readOnlyHint: true },
    },
    async () => text(formatExplore(await explore(root))),
  );

  server.registerTool(
    "preview_design_system",
    {
      description:
        "Write design/preview.html: one page with every token drawn in each mode and every component with its variants, for a person to look at (or for a browser tool to screenshot). With base, changes since that git ref are marked. Returns the file path.",
      inputSchema: { base: z.string().optional().describe("git ref to mark changes against, e.g. origin/main") },
    },
    async ({ base }) => {
      const { file, changes } = await writePreview(root, { base });
      return text(changes === undefined ? file : `${file}\n${changes} design system change${changes === 1 ? "" : "s"} since ${base}.`);
    },
  );

  server.registerTool(
    "verify_proposal",
    {
      description: "Check an open proposal against the code: every change it declares is in code, nothing else in the design system changed, and its tasks are done.",
      inputSchema: { name: z.string(), base: z.string().optional().describe("git ref with the spec before the change (default: origin/main or main)") },
      annotations: { readOnlyHint: true },
    },
    async ({ name, base }) => {
      try {
        return text(JSON.stringify(await verifyProposal(root, name, base), null, 2));
      } catch (error) {
        return failure((error as Error).message);
      }
    },
  );

  server.registerTool(
    "figma_export_script",
    {
      description:
        "Step 1 of comparing Figma with code: returns a read-only Figma Plugin API script. Run it with the Figma MCP use_figma tool on the design file, then pass its result to figma_diff. If the result is over use_figma's size limit, export a few collections at a time.",
      inputSchema: { collections: z.array(z.string()).optional().describe("Only these Figma collections") },
      annotations: { readOnlyHint: true },
    },
    async ({ collections }) => {
      const { config } = await load();
      return text(`${config.figma?.fileKey ? `Figma file: ${config.figma.fileKey}\n\n` : ""}${exportScript(collections)}`);
    },
  );

  server.registerTool(
    "figma_diff",
    {
      description: "Step 2: compare the figma_export_script result with the spec. Reports values that differ per mode, tokens only in Figma or only in code.",
      inputSchema: { exports: z.array(z.string()).describe("The JSON results of running figma_export_script with use_figma (one per collection batch)") },
      annotations: { readOnlyHint: true },
    },
    async ({ exports }) => {
      const { config, spec } = await load();
      try {
        return text(reportFigmaDiff(figmaDiff(parseExports(exports), spec, config), "markdown"));
      } catch (error) {
        return failure(`Could not read the export: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "figma_push_script",
    {
      description:
        "Step 3, only after the user approves: returns a Plugin API script that writes the code values into Figma for the differences (as aliases where code uses one). Run it with use_figma.",
      inputSchema: {
        exports: z.array(z.string()).describe("The JSON results of figma_export_script"),
        tokens: z.array(z.string()).optional().describe("Only these tokens, e.g. ['--scrollbar-thumb']"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ exports, tokens }) => {
      const { config, spec } = await load();
      try {
        const exported = parseExports(exports);
        const { script, steps } = figmaPushScript(exported, figmaDiff(exported, spec, config), tokens);
        if (steps.length === 0) return text("Nothing to push: Figma matches the code for these tokens.");
        return text(`Changes:\n${steps.map((s) => `- ${s.label}`).join("\n")}\n\nScript:\n${script}`);
      } catch (error) {
        return failure(`Could not read the export: ${(error as Error).message}`);
      }
    },
  );

  // Prompts show up as slash commands in clients, e.g. `/mcp__designspec__check_changes` in Claude Code.
  server.registerPrompt(
    "check_changes",
    { title: "Check my UI changes", description: "Check the UI files changed in this session against the design system and fix what it finds." },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Check every UI file you created or changed in this session against the design system: call the designspec check_code tool with each file's full contents and its project-relative path. Fix every error using the suggested tokens, components and variants. If something the design system doesn't cover is needed, call propose_change instead of inventing it. Finish with a short summary of what you fixed.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "apply",
    {
      title: "Implement a design system proposal",
      description: "Implement an open proposal's tasks, then sync, migrate and verify.",
      argsSchema: { name: z.string().describe("The proposal, e.g. panel-compact-padding") },
    },
    ({ name }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Implement the design system proposal "${name}": read its proposal.md and tasks.md in the spec's changes folder, make the code changes it describes (token sources, components in the UI directory), then run \`npx designspec-cli apply ${name}\`. Fix anything verify reports as missing or undeclared, and finish when \`npx designspec-cli verify ${name}\` passes.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "propose",
    {
      title: "Propose a design system change",
      description: "Open a design system change proposal for a need the current tokens and components don't cover.",
      argsSchema: { need: z.string().describe("What the UI needs, e.g. 'a warning color for quota alerts'") },
    },
    ({ need }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `The UI needs: ${need}\n\nFirst confirm the design system doesn't already cover it (list_components, find_tokens). If it does, show how to use the existing option. If it doesn't, call propose_change with a kebab-case name, why it is needed, what changes, and the existing options you considered.`,
          },
        },
      ],
    }),
  );

  return server;
}

function describe(token: Token) {
  const radius = /^radius-(.+)$/.exec(token.name)?.[1];
  const usage =
    token.code ??
    (token.utility ? `bg-${token.utility} / text-${token.utility} / border-${token.utility}` : radius ? `rounded-${radius}` : token.cssVar ? `var(${token.cssVar})` : token.name);
  return { name: token.name, type: token.type, value: token.value, modes: token.modes, usage };
}

export async function serveMcp(root: string, version: string): Promise<void> {
  await createMcpServer(root, version).connect(new StdioServerTransport());
}
