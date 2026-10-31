import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../src/check/index.js";
import { arbitraryValue, stripVariants } from "../src/check/classes.js";
import { apply, archive, createProposal, init, propose, sync } from "../src/commands.js";
import { explore, specAt, verifyProposal } from "../src/workflow.js";
import { figmaDiff, figmaPushScript, parseExports } from "../src/figma.js";
import { runFix } from "../src/fix.js";
import { writeAgentFiles } from "../src/agents.js";
import { measureAdoption } from "../src/adoption.js";
import { doctor } from "../src/doctor.js";
import { markdownReport } from "../src/report.js";
import type { Violation } from "../src/check/types.js";
import { createMcpServer } from "../src/mcp.js";
import { type ReviewClient, renderDiff, runReview } from "../src/review.js";
import { nearestColorToken, nearestColorTokenFor, parseColor } from "../src/color.js";
import { parseUnifiedDiff } from "../src/git.js";
import { configJsonSchema, loadConfig, RULE_IDS, SCHEMA_URL } from "../src/config.js";
import { FILE_RULES, PROJECT_RULES } from "../src/check/rules/index.js";
import { loadSpec } from "../src/spec.js";
import { changesMarkdown, tokenGroup, valueIn, writePreview } from "../src/preview.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures/next-shadcn");
let root: string;

function git(...args: string[]) {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd: root, stdio: "ignore" });
}

function edit(file: string, from: string, to: string) {
  const abs = path.join(root, file);
  const text = readFileSync(abs, "utf8");
  if (!text.includes(from)) throw new Error(`"${from}" not found in ${file}`);
  writeFileSync(abs, text.replace(from, to));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "designspec-"));
  cpSync(FIXTURE, root, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("init", () => {
  it("detects the stack and extracts tokens and components", async () => {
    await init(root, { force: false, agents: true, baseline: false });
    const config = await loadConfig(root);
    expect(config.presets).toEqual(["react", "tailwind-v4", "shadcn", "base-ui", "radix"]);
    expect(config.uiDir).toBe("src/components/ui");
    expect(config.cssFiles).toEqual(["src/app/globals.css"]);

    const spec = await loadSpec(root, config);
    const primary = spec.tokens.find((t) => t.cssVar === "--primary");
    expect(primary).toMatchObject({ type: "color", value: "oklch(0.205 0 0)", utility: "primary", modes: { dark: "oklch(0.922 0 0)" } });
    // Non-color @theme aliases are tokens too: rounded-lg.
    expect(spec.tokens.find((t) => t.cssVar === "--radius-lg")).toMatchObject({ type: "dimension", value: "var(--radius)" });

    const button = spec.components.find((c) => c.name === "Button");
    expect(button?.exports).toEqual(["Button", "buttonVariants"]);
    expect(button?.variants.Button.size).toEqual(["default", "sm", "lg", "icon"]);
    expect(button?.replaces).toEqual(["button"]);
    expect(button?.controls.Button).toEqual({ size: ["height", "padding", "radius"] });
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("designspec propose");
    expect(JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers.designspec.args).toEqual(["-y", "designspec", "mcp"]);
    expect(readFileSync(path.join(root, ".claude/skills/designspec-ui/SKILL.md"), "utf8")).toContain("nearest `designspec.config.json`");
  });
});

describe("check", () => {
  beforeEach(() => init(root, { force: false, agents: false, baseline: false }));

  it("reports every kind of violation in the fixture page", async () => {
    const { violations } = await runCheck({ root });
    const found = violations.map((v) => `${v.line}:${v.rule}`);
    expect(found).toEqual([
      "1:restricted-import",
      "9:no-hardcoded-color",
      "10:no-arbitrary-value",
      "10:no-palette-color",
      "12:prefer-ds-component",
      "15:prefer-ds-component",
      "16:no-unknown-variant",
      "18:no-unknown-variant",
      "19:no-hardcoded-color",
      "22:no-hardcoded-color",
      "24:no-variant-override",
      "24:no-variant-override",
    ]);
    expect(violations.find((v) => v.line === 9)?.suggestion).toContain("text-foreground");
    expect(violations.every((v) => v.file === "src/app/page.tsx")).toBe(true);
  });

  it("honors rule configuration", async () => {
    const configFile = path.join(root, "designspec.config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.rules = {
      "no-arbitrary-value": "off",
      "prefer-ds-component": "warn",
      "no-variant-override": ["error", { allow: ["rounded-none"] }],
      "no-hardcoded-color": ["error", { ignore: ["src/app/**"] }],
    };
    writeFileSync(configFile, JSON.stringify(config));
    const { violations } = await runCheck({ root });
    expect(violations.some((v) => v.rule === "no-arbitrary-value" || v.rule === "no-hardcoded-color")).toBe(false);
    expect(violations.filter((v) => v.rule === "no-variant-override").map((v) => v.message)).toEqual([
      `"h-12" overrides the height that Button's size variant controls.`,
    ]);
    expect(violations.filter((v) => v.rule === "prefer-ds-component").every((v) => v.severity === "warn")).toBe(true);
  });
});

describe("monorepo", () => {
  it("puts skills and the MCP server at the git root, pointed at the app", async () => {
    const app = path.join(root, "apps/web");
    rmSync(root, { recursive: true, force: true });
    cpSync(FIXTURE, app, { recursive: true });
    git("init", "-q", "-b", "main");
    await init(app, { force: false, agents: true, baseline: false });
    const mcp = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["designspec-web"].args).toEqual(["-y", "designspec", "-C", "apps/web", "mcp"]);
    expect(readFileSync(path.join(root, ".claude/skills/designspec-propose/SKILL.md"), "utf8")).toContain("name: designspec-propose");
    expect(readFileSync(path.join(app, "AGENTS.md"), "utf8")).toContain("design system");
  });
});

describe("adoption", () => {
  it("doesn't require a proposal in the PR that adds designspec", async () => {
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "before designspec");
    await init(root, { force: false, agents: true, baseline: true });
    rmSync(path.join(root, "design/changes/.gitkeep"));
    const { violations } = await runCheck({ root, diffBase: "main" });
    expect(violations).toEqual([]);
  });
});

describe("pull request flow", () => {
  beforeEach(async () => {
    await init(root, { force: false, agents: false, baseline: true });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "init");
  });

  it("requires a proposal for imported token files, not for spec-only updates", async () => {
    // Token CSS split into an imported file, as in many real projects.
    writeFileSync(path.join(root, "src/app/tokens.css"), ":root {\n  --brand: #1850ff;\n}\n");
    edit("src/app/globals.css", `@import "tailwindcss";`, `@import "tailwindcss";\n@import "./tokens.css";`);
    await sync(root);
    git("add", "-A");
    git("commit", "-qm", "split tokens");

    edit("src/app/tokens.css", "#1850ff", "#1a4fff");
    let { violations } = await runCheck({ root, diffBase: "HEAD" });
    expect(violations.find((v) => v.rule === "require-proposal")?.file).toBe("src/app/tokens.css");

    git("checkout", "-q", "--", "src/app/tokens.css");
    const tokensFile = path.join(root, "design/tokens.json");
    writeFileSync(tokensFile, readFileSync(tokensFile, "utf8").replace(/\n$/, "\n\n"));
    ({ violations } = await runCheck({ root, diffBase: "HEAD" }));
    expect(violations.some((v) => v.rule === "require-proposal")).toBe(false);
  });

  it("doesn't treat changes/.gitkeep as a proposal", async () => {
    git("rm", "-q", "--cached", "design/changes/.gitkeep");
    git("commit", "-qm", "drop gitkeep");
    edit("src/components/ui/button.tsx", 'icon: "size-9",', 'icon: "size-9",\n        xl: "h-12 px-8",');
    await sync(root);
    // .gitkeep is back as an untracked change, like in the PR that adds designspec.
    const { violations } = await runCheck({ root, diffBase: "main" });
    expect(violations.map((v) => v.rule)).toContain("require-proposal");
  });

  it("only reports new violations and requires a proposal for design system changes", async () => {
    edit("src/app/page.tsx", "<h1", '<p className="bg-[#3b82f6]">New</p>\n      <h1');
    edit("src/components/ui/button.tsx", 'icon: "size-9",', 'icon: "size-9",\n        xl: "h-12 px-8",');

    let { violations } = await runCheck({ root, diffBase: "main" });
    expect(violations.map((v) => v.rule).sort()).toEqual(["no-hardcoded-color", "require-proposal", "spec-drift"]);
    expect(violations.find((v) => v.rule === "require-proposal")?.file).toBe("src/components/ui/button.tsx");

    await sync(root);
    await propose(root, "button-size-xl");
    ({ violations } = await runCheck({ root, diffBase: "main" }));
    expect(violations.map((v) => v.rule)).toEqual(["no-hardcoded-color"]);

    await archive(root, "button-size-xl");
    ({ violations } = await runCheck({ root, diffBase: "main" }));
    expect(violations.map((v) => v.rule)).toEqual(["no-hardcoded-color"]);
  });

  it("keeps baselined violations quiet in full scans", async () => {
    const result = await runCheck({ root });
    expect(result.violations).toEqual([]);
    expect(result.baselined).toBe(12);
  });
});

describe("helpers", () => {
  it("strips Tailwind variants and modifiers", () => {
    expect(stripVariants("md:hover:!bg-[#fff]")).toBe("bg-[#fff]");
    expect(stripVariants("[&_svg]:size-4")).toBe("size-4");
    expect(stripVariants("-mt-2")).toBe("mt-2");
  });

  it("parses arbitrary values", () => {
    expect(arbitraryValue("p-[13px]")).toEqual({ prefix: "p", value: "13px" });
    expect(arbitraryValue("grid-cols-[auto_1fr]")).toEqual({ prefix: "grid-cols", value: "auto_1fr" });
    expect(arbitraryValue("bg-[color:#fff]/50")).toEqual({ prefix: "bg", value: "#fff" });
    expect(arbitraryValue("[mask-type:luminance]")).toEqual({ prefix: "[mask-type]", value: "luminance" });
    expect(arbitraryValue("bg-primary")).toBeNull();
  });

  it("treats calc() and other non-colors as non-colors without throwing", () => {
    expect(parseColor("calc(100dvh-3.5rem)")).toBeUndefined();
    expect(parseColor("var(--primary)")).toBeUndefined();
    expect(parseColor("222.2 47.4% 11.2%")).toBeDefined();
  });

  it("doesn't suggest opaque tokens for translucent colors", () => {
    const tokens = [{ name: "label", type: "color" as const, value: "#000000", code: "colors.label" }];
    expect(nearestColorToken("#111111", tokens)?.code).toBe("colors.label");
    expect(nearestColorToken("rgba(0, 0, 0, 0.55)", tokens)).toBeUndefined();
  });

  it("prefers tokens that match the utility's role", () => {
    const tokens = [
      { name: "card", type: "color" as const, value: "#ffffff", utility: "card" },
      { name: "primary-foreground", type: "color" as const, value: "#fafafa", utility: "primary-foreground" },
    ];
    expect(nearestColorTokenFor("text", "#ffffff", tokens)?.name).toBe("primary-foreground");
    expect(nearestColorTokenFor("bg", "#ffffff", tokens)?.name).toBe("card");
  });

  it("parses added lines from a unified diff", () => {
    const patch = ["diff --git a/x.tsx b/x.tsx", "--- a/x.tsx", "+++ b/x.tsx", "@@ -3,0 +4,2 @@", "+a", "+b", "@@ -10 +12 @@", "-c", "+d"].join("\n");
    expect([...(parseUnifiedDiff(patch).get("x.tsx") as Set<number>)]).toEqual([4, 5, 12]);
  });
});

async function initFixture(name: string) {
  rmSync(root, { recursive: true, force: true });
  cpSync(path.join(import.meta.dirname, "fixtures", name), root, { recursive: true });
  await init(root, { force: false, agents: false, baseline: false });
}

function setConfig(patch: Record<string, unknown>) {
  const file = path.join(root, "designspec.config.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
}

describe("react native", () => {
  beforeEach(() => initFixture("expo"));

  it("reads tokens from theme modules and variants from prop types", async () => {
    const config = await loadConfig(root);
    expect(config.presets).toEqual(["react-native"]);
    expect(config.themeFiles).toEqual(["theme/colors.ts", "theme/radius.ts", "theme/spacing.ts"]);

    const spec = await loadSpec(root, config);
    expect(spec.tokens.find((t) => t.code === "spacing.md")).toMatchObject({ type: "dimension", value: "16" });
    expect(spec.tokens.find((t) => t.code === "colors.accent")).toMatchObject({ type: "color", value: "#007aff" });
    // Platform-dependent values are skipped.
    expect(spec.tokens.some((t) => t.code === "control.minTouch")).toBe(false);

    const button = spec.components.find((c) => c.name === "Button");
    expect(button?.variants.Button).toEqual({ variant: ["primary", "secondary", "ghost"], size: ["sm", "md"] });
    expect(button?.defaults.Button).toEqual({ variant: "primary", size: "md" });
    // action-row.tsx and action-row.ios.tsx are one component.
    expect(spec.components.filter((c) => c.name === "ActionRow").map((c) => c.source)).toEqual(["components/ui/action-row.tsx"]);
  });

  it("checks styles, primitives and variants", async () => {
    const { violations } = await runCheck({ root });
    expect(violations.map((v) => `${v.line}:${v.rule}:${v.suggestion}`)).toEqual([
      `9:prefer-ds-component:import { ThemedText } from "@/components/ui/text"`,
      "9:no-hardcoded-color:Closest token: colors.systemRed.",
      `10:prefer-ds-component:import { Touchable } from "@/components/ui/touchable"`,
      "11:no-unknown-variant:Allowed: primary, secondary, ghost. Need a new one? Run `designspec propose`.",
      "13:no-raw-style-value:Use -spacing.sm.",
      "20:no-raw-style-value:Use spacing.md.",
      "21:no-raw-style-value:Use a spacing token (4, 8, 16, 24), or propose a new one with `designspec propose`.",
      "22:no-raw-style-value:Use radius.md.",
      "24:no-hardcoded-color:Closest token: colors.systemBackground.",
      "27:no-hardcoded-color:Closest token: colors.label.",
      "32:no-hardcoded-color:Use a color token. If none fits, run `designspec propose` to add one.",
    ]);
  });
});

describe("tailwind v3", () => {
  beforeEach(() => initFixture("vite-tailwind3"));

  it("maps utilities from tailwind.config and suggests the closest token for palette colors", async () => {
    const config = await loadConfig(root);
    expect(config.tailwindConfig).toBe("tailwind.config.ts");
    const spec = await loadSpec(root, config);
    expect(spec.tokens.find((t) => t.cssVar === "--primary-foreground")?.utility).toBe("primary-foreground");
    expect(spec.tokens.find((t) => t.name === "brand")).toMatchObject({ type: "color", value: "#1850ff", utility: "brand" });

    const { violations } = await runCheck({ root });
    expect(violations.map((v) => `${v.rule}:${v.suggestion}`)).toEqual([
      "no-palette-color:Closest token: bg-destructive.",
      "no-hardcoded-color:Closest token: text-brand.",
    ]);
  });
});

describe("zones and eslint comments", () => {
  beforeEach(async () => {
    await initFixture("next-shadcn");
    edit("src/app/globals.css", "  --color-border: var(--border);", "  --color-border: var(--border);\n  --color-landing-fg: var(--landing-fg);");
    edit("src/app/globals.css", "  --border: oklch(0.922 0 0);\n}", "  --border: oklch(0.922 0 0);\n  --landing-fg: #f5f5f5;\n}");
    await sync(root);
  });

  it("keeps marketing tokens out of product UI and vice versa", async () => {
    writeFileSync(path.join(root, "src/app/promo.tsx"), `export const Promo = () => <p className="text-landing-fg/80">Hi</p>\n`);
    writeFileSync(path.join(root, "src/components/hero.tsx"), `export const Hero = () => <p className="text-landing-fg bg-primary">Hi</p>\n`);
    setConfig({
      zones: [
        { name: "product", files: ["src/app/**"], denyTokens: ["landing-*"] },
        { name: "marketing", files: ["src/components/hero.tsx"], allowTokens: ["landing-*"] },
      ],
    });
    const { violations } = await runCheck({ root, paths: ["src/app/promo.tsx", "src/components/hero.tsx"] });
    expect(violations.filter((v) => v.rule === "zone-tokens").map((v) => `${v.file}:${v.message}`)).toEqual([
      `src/app/promo.tsx:Token "landing-fg" (text-landing-fg/80) is not allowed in the product zone.`,
      `src/components/hero.tsx:Token "primary" (bg-primary) is not allowed in the marketing zone.`,
    ]);
  });

  it("honors eslint-disable comments for aliased ESLint rules", async () => {
    writeFileSync(
      path.join(root, "src/app/legacy.tsx"),
      [
        "export const A = () => (",
        "  <div>",
        "    {/* eslint-disable-next-line acme/design-tokens -- brand ribbon */}",
        `    <span className="bg-red-500" />`,
        "    {/* eslint-disable-next-line other/rule */}",
        `    <span className="bg-blue-500" />`,
        "  </div>",
        ")",
      ].join("\n"),
    );
    setConfig({ eslintAliases: { "acme/design-tokens": ["no-palette-color", "no-hardcoded-color"] } });
    const { violations } = await runCheck({ root, paths: ["src/app/legacy.tsx"] });
    expect(violations.map((v) => `${v.line}:${v.rule}`)).toEqual(["6:no-palette-color"]);
  });
});

describe("fix", () => {
  beforeEach(() => init(root, { force: false, agents: false, baseline: false }));

  it("rewrites exact variant overrides into the variant and leaves everything else", async () => {
    writeFileSync(
      path.join(root, "src/app/actions.tsx"),
      [
        `import { Button } from "@/components/ui/button"`,
        `import { cn } from "@/lib/utils"`,
        ``,
        `export const Actions = ({ wide }: { wide: boolean }) => (`,
        `  <div>`,
        `    <Button size="lg" className="h-8 rounded-md px-3">Exact, attribute removed</Button>`,
        `    <Button variant="outline" size="lg" className="h-8 rounded-md px-3 w-full">Replaces size</Button>`,
        `    <Button size="lg" className={cn("h-8 rounded-md px-3", wide && "w-full")}>Inside cn</Button>`,
        `    <Button size="icon" className="h-8 rounded-md px-3">Icon size also sets width, kept</Button>`,
        `    <Button className="h-8 px-3">Partial, kept</Button>`,
        `    <Button className="h-8 rounded-md px-3">Default size keeps py-2 today, kept</Button>`,
        `    <Button variant="link" className="h-9 px-4 py-2">Redundant, same as the default size</Button>`,
        `  </div>`,
        `)`,
      ].join("\n"),
    );
    const fixes = await runFix(root, { paths: ["src/app/actions.tsx"] });
    expect(fixes[0].changes).toEqual([
      `6: <Button> h-8 rounded-md px-3 → size="sm"`,
      `7: <Button> h-8 rounded-md px-3 → size="sm"`,
      `8: <Button> h-8 rounded-md px-3 → size="sm"`,
      `12: <Button> h-9 px-4 py-2 → size="default"`,
    ]);
    const lines = readFileSync(path.join(root, "src/app/actions.tsx"), "utf8").split("\n");
    expect(lines.slice(5, 12)).toEqual([
      `    <Button size="sm">Exact, attribute removed</Button>`,
      `    <Button variant="outline" size="sm" className="w-full">Replaces size</Button>`,
      `    <Button size="sm" className={cn(wide && "w-full")}>Inside cn</Button>`,
      `    <Button size="icon" className="h-8 rounded-md px-3">Icon size also sets width, kept</Button>`,
      `    <Button className="h-8 px-3">Partial, kept</Button>`,
      `    <Button className="h-8 rounded-md px-3">Default size keeps py-2 today, kept</Button>`,
      `    <Button variant="link" size="default">Redundant, same as the default size</Button>`,
    ]);
    const { violations } = await runCheck({ root, paths: ["src/app/actions.tsx"] });
    expect(violations.filter((v) => v.line <= 8 && v.rule === "no-variant-override")).toEqual([]);
  });
});

describe("mcp", () => {
  beforeEach(() => init(root, { force: false, agents: false, baseline: false }));

  async function connect() {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer(root, "test").connect(serverTransport);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      return { text: result.content[0].text, isError: result.isError };
    };
    return { client, call };
  }

  it("lets agents look up components and tokens, check code and propose changes", async () => {
    const { client, call } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["apply", "check_changes", "propose"]);
    const prompt = await client.getPrompt({ name: "propose", arguments: { need: "a warning color" } });
    expect((prompt.messages[0].content as { text: string }).text).toContain("The UI needs: a warning color");

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_code",
      "explore_design_system",
      "figma_diff",
      "figma_export_script",
      "figma_push_script",
      "find_tokens",
      "get_component",
      "get_rules",
      "list_components",
      "preview_design_system",
      "propose_change",
      "verify_proposal",
    ]);

    const components = JSON.parse((await call("list_components", { query: "button" })).text);
    expect(components[0]).toMatchObject({ name: "Button", import: "@/components/ui/button", replaces: ["button"] });
    expect((await call("get_component", { name: "Button" })).text).toContain("variant: [ default, destructive, outline, ghost, link ]");
    expect((await call("get_component", { name: "Nope" })).isError).toBe(true);

    const closest = JSON.parse((await call("find_tokens", { color: "#e5484d" })).text);
    expect(closest[0]).toMatchObject({ name: "destructive", usage: "bg-destructive / text-destructive / border-destructive" });

    const checked = await call("check_code", { file: "src/app/new.tsx", code: `export const A = () => <button className="bg-red-500">x</button>` });
    expect(checked.text).toContain("prefer-ds-component");
    expect(checked.text).toContain("Fix: Closest token: bg-destructive.");

    expect((await call("get_rules")).text).toContain("no-variant-override (error)");

    const proposal = await call("propose_change", { name: "add-warning-color", why: "Warnings look like errors.", what: "Add --warning." });
    expect(proposal.text).toContain("design/changes/add-warning-color/proposal.md");
    expect(readFileSync(path.join(root, "design/changes/add-warning-color/proposal.md"), "utf8")).toContain("Warnings look like errors.");
  });
});

describe("fix colors", () => {
  beforeEach(async () => {
    await init(root, { force: false, agents: false, baseline: false });
    edit("src/app/globals.css", "  --color-border: var(--border);", "  --color-border: var(--border);\n  --color-brand: var(--brand);");
    edit("src/app/globals.css", "  --border: oklch(0.922 0 0);\n}", "  --border: oklch(0.922 0 0);\n  --brand: #1850ff;\n}");
    await sync(root);
    writeFileSync(
      path.join(root, "src/app/colors.tsx"),
      `export const C = () => <p className="bg-[#1850ff]/50 hover:text-[#1850FF] text-[#1850fe] border-[#ffffff]">x</p>\n`,
    );
  });

  it("replaces exact token colors and leaves near misses and themed tokens alone by default", async () => {
    const [fix] = await runFix(root, { paths: ["src/app/colors.tsx"] });
    expect(fix.changes).toEqual(["1: bg-[#1850ff]/50 → bg-brand/50", "1: text-[#1850FF] → text-brand"]);
    expect(readFileSync(path.join(root, "src/app/colors.tsx"), "utf8")).toContain(`className="bg-brand/50 hover:text-brand text-[#1850fe] border-[#ffffff]"`);
  });

  it("uses tokens with a dark mode only with colors: true", async () => {
    const [fix] = await runFix(root, { paths: ["src/app/colors.tsx"], colors: true, dryRun: true });
    expect(fix.changes).toContain("1: border-[#ffffff] → border-background (adapts to dark mode)");
  });
});

describe("review", () => {
  beforeEach(async () => {
    await init(root, { force: false, agents: false, baseline: true });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "init");
    edit("src/app/page.tsx", "<h1", `<div className="flex gap-2"><span>Saved</span></div>\n      <h1`);
  });

  it("renders added lines with their new line numbers", () => {
    const patch = ["diff --git a/x.tsx b/x.tsx", "--- a/x.tsx", "+++ b/x.tsx", "@@ -3,2 +3,3 @@", " keep", "-old", "+new", "+newer"].join("\n");
    const { text, added } = renderDiff(patch);
    expect(text).toBe(["### x.tsx", "     ...", "     3 | keep", "       - old", "     4 + new", "     5 + newer"].join("\n"));
    expect([...(added.get("x.tsx") ?? [])]).toEqual([4, 5]);
  });

  it("asks Claude with a cached design context and keeps findings on added lines only", async () => {
    let request: Record<string, any> = {};
    const finding = (line: number) => ({ file: "src/app/page.tsx", line, severity: "warning", rule: "one-primary-action", message: "m", suggestion: "s" });
    const client = {
      beta: {
        messages: {
          parse: async (params: Record<string, any>) => {
            request = params;
            return { stop_reason: "end_turn", usage: { input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 20 }, parsed_output: { findings: [finding(9), finding(1)] } };
          },
        },
      },
    } as unknown as ReviewClient;

    const result = await runReview(root, { diffBase: "main", client });
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.output_config.effort).toBe("medium");
    expect(request.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(request.system[0].text).toContain("- Button (@/components/ui/button; exports Button, buttonVariants) — variant: default|destructive|outline|ghost|link");
    expect(request.messages[0].content).toContain(`     9 +       <div className="flex gap-2">`);
    // Line 1 wasn't added in this PR.
    expect(result.findings.map((f) => f.line)).toEqual([9]);
    expect(result.usage?.cachedInputTokens).toBe(500);
  });

  it("skips without failing when there is no API key", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const result = await runReview(root, { diffBase: "main" });
      expect(result).toEqual({ findings: [], skipped: "No ANTHROPIC_API_KEY set; AI review skipped." });
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });
});

describe("config", () => {
  beforeEach(() => init(root, { force: false, agents: false, baseline: false }));

  it("keeps your settings when re-initialized with --force", async () => {
    setConfig({ rules: { "no-arbitrary-value": "off" }, zones: [{ name: "x", files: ["a/**"], denyTokens: ["b-*"] }] });
    await init(root, { force: true, agents: false, baseline: false });
    const config = await loadConfig(root);
    expect(config.rules["no-arbitrary-value"]).toBe("off");
    expect(config.zones[0].name).toBe("x");
    expect(config.presets).toContain("shadcn");
  });

  it("explains invalid config and unknown rules", async () => {
    setConfig({ rules: { "no-palette-colour": "error", "no-arbitrary-value": ["warn", { prefixs: ["p"] }] }, uiDir: 3 });
    await expect(loadConfig(root)).rejects.toThrow(/uiDir: Invalid input[\s\S]*rules: Unrecognized key: "no-palette-colour"/);
  });

  it("ships a JSON Schema that matches the config schema", () => {
    expect(JSON.parse(readFileSync(path.join(import.meta.dirname, "../schema.json"), "utf8"))).toEqual(configJsonSchema());
    expect(JSON.parse(readFileSync(path.join(root, "designspec.config.json"), "utf8")).$schema).toBe(SCHEMA_URL);
  });

  it("knows every rule", () => {
    expect([...FILE_RULES.map((r) => r.id), ...Object.keys(PROJECT_RULES)].sort()).toEqual([...RULE_IDS].sort());
  });
});

describe("css and token references", () => {
  beforeEach(() => init(root, { force: false, agents: false, baseline: false }));

  it("checks stylesheets outside the token sources", async () => {
    writeFileSync(
      path.join(root, "src/app/card.module.css"),
      [".card {", "  --local: 4px;", "  color: #e5484d;", "  padding: var(--local);", "  border-color: var(--bordr);", "  background: var(--color-primary);", "}"].join("\n"),
    );
    const { violations } = await runCheck({ root, paths: ["src/app"] });
    expect(violations.filter((v) => v.file.endsWith(".css")).map((v) => `${v.line}:${v.rule}:${v.message}`)).toEqual([
      "3:no-hardcoded-color:Hardcoded color color: #e5484d.",
      "5:no-unknown-token:Unknown token --bordr.",
    ]);
  });

  it("finds unknown tokens in classes and style objects, including MUI sx", async () => {
    writeFileSync(
      path.join(root, "src/app/refs.tsx"),
      [
        `export const A = () => (`,
        `  <div className="bg-(--primary) text-[var(--muted-foregrund)] w-(--sidebar-width)" style={{ "--sidebar-width": "16rem" }}>`,
        `    <p style={{ color: "var(--primray)" }} />`,
        `    <p sx={{ color: "#ff0000" }} />`,
        `  </div>`,
        `)`,
      ].join("\n"),
    );
    const { violations } = await runCheck({ root, paths: ["src/app/refs.tsx"] });
    expect(violations.map((v) => `${v.line}:${v.rule}:${v.message}`)).toEqual([
      "2:no-unknown-token:Unknown token --muted-foregrund.",
      "3:no-unknown-token:Unknown token --primray.",
      `4:no-hardcoded-color:Hardcoded color in style: color: "#ff0000".`,
    ]);
  });
});

describe("fix react native styles", () => {
  beforeEach(() => initFixture("expo"));

  it("replaces on-scale numbers with tokens and imports the token group", async () => {
    const [fix] = await runFix(root, { paths: ["app/index.tsx"] });
    expect(fix.changes).toEqual(["13: marginTop: -8 → -spacing.sm", "20: padding: 16 → spacing.md", "22: borderRadius: 12 → radius.md"]);
    const code = readFileSync(path.join(root, "app/index.tsx"), "utf8");
    expect(code).toContain(`import { spacing } from '@/theme/spacing'\nimport { radius } from '@/theme/radius'\n`);
    expect(code).toContain("margin: 13,"); // off the scale: a design decision, left alone
    const { violations } = await runCheck({ root, paths: ["app/index.tsx"] });
    expect(violations.filter((v) => v.rule === "no-raw-style-value").map((v) => v.line)).toEqual([22]);
  });

  it("adds to an existing import from the theme index", async () => {
    writeFileSync(path.join(root, "theme/index.ts"), `export * from './spacing'\nexport * from './radius'\nexport { colors } from './colors'\n`);
    writeFileSync(
      path.join(root, "app/card.tsx"),
      [`import { StyleSheet } from "react-native";`, `import { colors } from "@/theme";`, ``, `export const styles = StyleSheet.create({ card: { padding: 8, backgroundColor: colors.label } });`, ``].join("\n"),
    );
    await runFix(root, { paths: ["app/card.tsx"] });
    expect(readFileSync(path.join(root, "app/card.tsx"), "utf8")).toContain(`import { colors, spacing } from "@/theme";\n\nexport const styles = StyleSheet.create({ card: { padding: spacing.sm,`);
  });
});

describe("figma", () => {
  beforeEach(() => init(root, { force: false, agents: false, baseline: false }));

  // Shaped like the export script's result for a file mirroring the next-shadcn fixture.
  const exported = (overrides: { primaryDark?: string; ringDark?: string } = {}) => ({
    v: 2,
    file: "Design system",
    collections: [
      [
        "C:1",
        "Color",
        [["m:1", "Light"], ["m:2", "Dark"]],
        [
          ["V:1", "primary", "COLOR", "var(--primary)", ["#171717", overrides.primaryDark ?? "#e5e5e5"]],
          ["V:2", "border", "COLOR", "var(--border)", ["#e5e5e5", "#ffffff1a"]],
          ["V:3", "destructive", "COLOR", "var(--destructive)", ["#e7000b", "#ff6467"]],
          ["V:4", "ring", "COLOR", "var(--ring)", ["#e5e5e5", overrides.ringDark ?? "#ffffff1a"]],
          ["V:5", "primary/50", "COLOR", "color-mix(in oklab, var(--primary) 50%, transparent)", ["#17171780", "#e5e5e580"]],
          ["V:6", "brand", "COLOR", "var(--brand-new)", ["#1850ff", "#1850ff"]],
        ],
      ],
      [
        "C:2",
        "Radius",
        [["m:3", "Value"]],
        [
          ["V:7", "sm", "FLOAT", "var(--radius-sm)", [6]],
          ["V:8", "lg", "FLOAT", "var(--radius-lg)", [10]],
          ["V:9", "lg-mobile", "FLOAT", "var(--radius-lg)", [8]],
          ["V:10", "text/xs", "FLOAT", "var(--text-xs)", [12]],
          ["V:11", "gap/4", "FLOAT", "calc(var(--spacing) * 4)", [16]],
        ],
      ],
    ],
    primitives: [["P:1", "neutral/950", "Primitives", "#171717"]],
  });

  it("matches modes by name and compares like Figma stores values", async () => {
    // Fixture: --ring is defined in neither :root nor .dark, --border dark is oklch(1 0 0 / 10%), --radius 0.625rem.
    edit("src/app/globals.css", "  --border: oklch(0.922 0 0);\n}", "  --border: oklch(0.922 0 0);\n  --ring: var(--border);\n}");
    await sync(root);
    const config = await loadConfig(root);
    const diff = figmaDiff(parseExports([JSON.stringify(exported())]), await loadSpec(root, config), config);

    expect(diff.modeMap).toEqual({ Color: { Light: "base", Dark: "dark" }, Radius: { Value: "base" } });
    // primary dark is oklch(0.922 0 0) = #e5e5e5; destructive is out of sRGB gamut and matches once clipped;
    // ring resolves var(--border) in each mode; radius-sm is calc(var(--radius) - 4px) = 6;
    // --text-xs and --spacing come from Tailwind's defaults.
    expect(diff.mismatches).toEqual([]);
    expect(diff.matches).toBe(12);
    expect(diff.unchecked).toBe(1); // color-mix
    expect(diff.alternates.map((a) => a.figmaName)).toEqual(["lg-mobile"]);
    expect(diff.onlyInFigma).toEqual(["--brand-new"]);
    expect(diff.onlyInCode).toContain("--foreground");
  });

  it("reports differences and pushes them as aliases where possible", async () => {
    const config = await loadConfig(root);
    const spec = await loadSpec(root, config);
    edit("src/app/globals.css", "  --border: oklch(0.922 0 0);\n}", "  --border: oklch(0.922 0 0);\n  --ring: var(--border);\n}");
    await sync(root);
    const synced = await loadSpec(root, config);
    const data = parseExports([JSON.stringify(exported({ primaryDark: "#ff0000", ringDark: "#000000" }))]);
    const diff = figmaDiff(data, synced, config);
    expect(diff.mismatches.map((m) => `${m.cssVar} ${m.mode} ${m.figma} → ${m.codeResolved}`)).toEqual([
      "--primary Dark #ff0000 → #e5e5e5",
      "--ring Dark #000000 → #ffffff1a",
    ]);

    const { steps, script } = figmaPushScript(data, diff);
    // --ring is var(--border) in code, so Figma gets an alias to its border variable; no primitive matches #e5e5e5.
    expect(steps.map((s) => s.label)).toEqual(["primary [Dark] → #e5e5e5", "ring [Dark] → alias --border"]);
    expect(steps[1]).toMatchObject({ variableId: "V:4", modeId: "m:2", aliasId: "V:2" });
    expect(script).toContain("setValueForMode");
    expect(spec.tokens.length).toBeGreaterThan(0);
  });

  it("rejects files that aren't exports", () => {
    expect(() => parseExports(['{"collections": []}'])).toThrow(/Not a designspec Figma export/);
  });
});

describe("coverage", () => {
  beforeEach(async () => {
    await init(root, { force: false, agents: true, baseline: false });
    writeFileSync(path.join(root, "src/app/legacy.astro"), `---\n---\n<button style="color: #f00">x</button>\n`);
    writeFileSync(path.join(root, "src/app/banner.tsx"), `import { css } from "styled-system/css"\nexport const Banner = () => <div className={css({ bg: "red.500" })} />\n`);
  });

  it("says what it couldn't check instead of passing silently", async () => {
    const result = await runCheck({ root, paths: ["src/app/banner.tsx"] });
    expect(result.violations).toEqual([]);
    expect(result.notChecked.map((n) => `${n.what}: ${n.files.join(", ")}`)).toEqual([
      "Panda CSS: src/app/banner.tsx",
      "Astro: src/app/legacy.astro",
    ]);
    expect(markdownReport(result)).toContain("**Not checked**");
  });

  it("only reports what a pull request touches", async () => {
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(path.join(root, "src/app/other.astro"), "<p />\n");
    const result = await runCheck({ root, diffBase: "main" });
    expect(result.notChecked.map((n) => `${n.what}: ${n.files.join(", ")}`)).toEqual(["Astro: src/app/other.astro"]);
  });

  it("explains active and inactive rules in doctor", async () => {
    const report = await doctor(root);
    expect(report.presets).toContain("tailwind-v4");
    expect(report.rules.find((r) => r.id === "no-raw-style-value")).toEqual({ id: "no-raw-style-value", level: "inactive", why: "needs the react-native preset" });
    expect(report.rules.find((r) => r.id === "no-palette-color")?.level).toBe("error");
    expect(report.agents).toEqual({ agentsMd: true, skills: ["designspec-ui", "designspec-propose", "designspec-figma"], mcpServer: "designspec" });
    expect(report.notChecked.map((n) => n.what)).toEqual(["Panda CSS", "Astro"]);
  });
});

describe("token files", () => {
  it("reads DTCG and Tokens Studio files as the token source", async () => {
    mkdirSync(path.join(root, "tokens"), { recursive: true });
    writeFileSync(
      path.join(root, "tokens/base.tokens.json"),
      JSON.stringify({
        color: {
          $type: "color",
          blue: { 500: { $value: { colorSpace: "srgb", components: [0.094, 0.314, 1], hex: "#1850ff" } } },
          brand: { $value: "{color.blue.500}" },
          // Same variable as the CSS --primary: the file wins, the CSS utility (bg-primary) is kept.
          primary: { $value: { colorSpace: "oklch", components: [0.3, 0.1, 260] } },
        },
        space: { md: { $type: "dimension", $value: { value: 16, unit: "px" } } },
        primary: { $value: "{color.primary}", $type: "color" },
      }),
    );
    writeFileSync(path.join(root, "tokens/dark.json"), JSON.stringify({ color: { brand: { $type: "color", $value: "#6b9bff" } } }));
    writeFileSync(
      path.join(root, "tokens/studio.json"),
      JSON.stringify({ global: { radius: { card: { value: "12px", type: "borderRadius" } } }, $themes: [] }),
    );
    await init(root, { force: false, agents: false, baseline: false });
    expect((await loadConfig(root)).tokenFiles).toEqual(["tokens/base.tokens.json", "tokens/dark.json", "tokens/studio.json"]);

    setConfig({ tokenFiles: ["tokens/base.tokens.json", { path: "tokens/dark.json", mode: "dark" }, { path: "tokens/studio.json", set: "global" }] });
    await sync(root);
    const spec = await loadSpec(root, await loadConfig(root));
    const token = (cssVar: string) => spec.tokens.find((t) => t.cssVar === cssVar);

    expect(token("--color-brand")).toMatchObject({ type: "color", value: "color(srgb 0.094 0.314 1 / 1)", modes: { dark: "#6b9bff" } });
    expect(token("--space-md")).toMatchObject({ type: "dimension", value: "16px" });
    expect(token("--radius-card")).toMatchObject({ type: "dimension", value: "12px" });
    expect(token("--primary")).toMatchObject({ value: "oklch(0.3 0.1 260 / 1)", utility: "primary" });
    expect(spec.tokens.filter((t) => t.cssVar === "--primary")).toHaveLength(1);

    // Suggestions use them.
    writeFileSync(path.join(root, "src/app/promo.tsx"), `export const P = () => <p className="text-[#1850ff]" />\n`);
    const { violations } = await runCheck({ root, paths: ["src/app/promo.tsx"] });
    // No Tailwind utility for file tokens here, so the fix is an arbitrary value that references the token.
    expect(violations[0].suggestion).toBe("Closest token: text-[var(--color-blue-500)].");
  });
});

describe("styled-components and Emotion", () => {
  beforeEach(() => init(root, { force: false, agents: false, baseline: false }));

  it("checks CSS in templates and object styles at the right lines", async () => {
    writeFileSync(
      path.join(root, "src/app/card.tsx"),
      [
        `import styled, { css } from "styled-components"`,
        `import { Button } from "@/components/ui/button"`,
        ``,
        `const muted = css\``,
        `  color: var(--muted-foregrund);`,
        `\``,
        ``,
        `export const Card = styled.div<{ active: boolean }>\``,
        `  padding: 16px;`,
        `  border: 1px solid \${(p) => (p.active ? "red" : "blue")};`,
        `  background: #fafafa;`,
        `  \${muted};`,
        `  &:hover { color: var(--primary); }`,
        `\``,
        ``,
        `export const Wide = styled(Button).attrs({ type: "button" })\`box-shadow: 0 0 0 1px #000;\``,
        `export const Tag = styled.span({ color: "#e5484d" })`,
        `export const Box = () => <div css={{ borderColor: "#ff0000" }} />`,
      ].join("\n"),
    );
    const { violations } = await runCheck({ root, paths: ["src/app/card.tsx"] });
    expect(violations.map((v) => `${v.line}:${v.column}:${v.rule}`)).toEqual([
      "5:10:no-unknown-token",
      "11:15:no-hardcoded-color",
      "16:74:no-hardcoded-color", // start of the value, as in CSS files
      "17:42:no-hardcoded-color",
      "18:52:no-hardcoded-color",
    ]);
  });

  it("leaves unrelated css helpers alone", async () => {
    writeFileSync(path.join(root, "src/app/plain.tsx"), "const css = (s: TemplateStringsArray) => s.join('')\nexport const x = css`color: #ff0000;`\n");
    const { violations } = await runCheck({ root, paths: ["src/app/plain.tsx"] });
    expect(violations).toEqual([]);
  });
});

describe("tailwind-variants", () => {
  it("reads tv() variants like cva()", async () => {
    writeFileSync(
      path.join(root, "src/components/ui/badge.tsx"),
      [
        `import { tv, type VariantProps } from "tailwind-variants"`,
        `const badge = tv({`,
        `  base: "inline-flex rounded-md",`,
        `  variants: {`,
        `    tone: { neutral: "bg-muted", danger: "bg-destructive" },`,
        `    size: { sm: { base: "h-5 px-1.5", icon: "size-3" }, md: "h-6 px-2" },`,
        `  },`,
        `  defaultVariants: { tone: "neutral", size: "md" },`,
        `})`,
        `export function Badge({ tone, size, className, ...props }: VariantProps<typeof badge> & React.ComponentProps<"span">) {`,
        `  return <span className={badge({ tone, size, className })} {...props} />`,
        `}`,
        `export { badge }`,
      ].join("\n"),
    );
    await init(root, { force: false, agents: false, baseline: false });
    const badge = (await loadSpec(root, await loadConfig(root))).components.find((c) => c.name === "Badge");
    expect(badge?.variants.Badge).toEqual({ tone: ["neutral", "danger"], size: ["sm", "md"] });
    expect(badge?.defaults.Badge).toEqual({ tone: "neutral", size: "md" });
    expect(badge?.controls.Badge).toEqual({ size: ["height", "padding"] });

    writeFileSync(
      path.join(root, "src/app/tags.tsx"),
      [
        `import { tv } from "tailwind-variants"`,
        `import { Badge, badge } from "@/components/ui/badge"`,
        `const local = tv({ base: "bg-red-500" })`,
        `export const T = () => <>`,
        `  <Badge tone="warning" />`,
        `  <Badge className="h-8" />`,
        `  <i className={badge({ size: "lg" })} />`,
        `</>`,
      ].join("\n"),
    );
    const { violations } = await runCheck({ root, paths: ["src/app/tags.tsx"] });
    expect(violations.map((v) => `${v.line}:${v.rule}`)).toEqual(["3:no-palette-color", "5:no-unknown-variant", "6:no-variant-override", "7:no-unknown-variant"]);
  });
});

describe("design system packages", () => {
  it("finds a workspace UI package and resolves barrel imports", async () => {
    rmSync(root, { recursive: true, force: true });
    const ui = path.join(root, "packages/ui");
    const app = path.join(root, "apps/web");
    mkdirSync(path.join(ui, "src"), { recursive: true });
    writeFileSync(path.join(ui, "package.json"), JSON.stringify({ name: "@acme/ui", exports: { ".": "./src/index.ts" } }));
    cpSync(path.join(FIXTURE, "src/components/ui/button.tsx"), path.join(ui, "src/button.tsx"));
    writeFileSync(path.join(ui, "src/index.ts"), `export * from "./button"\n`);
    cpSync(FIXTURE, app, { recursive: true });
    rmSync(path.join(app, "src/components"), { recursive: true });
    rmSync(path.join(app, "components.json"));
    writeFileSync(path.join(app, "package.json"), JSON.stringify({ dependencies: { "@acme/ui": "workspace:*", react: "19.0.0", tailwindcss: "4.1.0" } }));
    mkdirSync(path.join(app, "node_modules/@acme"), { recursive: true });
    // "junction" works on Windows without admin rights; the type is ignored elsewhere.
    symlinkSync(ui, path.join(app, "node_modules/@acme/ui"), "junction");
    writeFileSync(path.join(app, "src/app/page.tsx"), `import { Button } from "@acme/ui"\nexport default () => <><Button variant="ghost2" /><Button className="h-12" /><button /></>\n`);

    await init(app, { force: false, agents: false, baseline: false });
    const config = await loadConfig(app);
    expect([config.uiDir, config.uiImport]).toEqual(["../../packages/ui/src", "@acme/ui"]);
    const spec = await loadSpec(app, config);
    expect(spec.components.find((c) => c.name === "Button")?.import).toBe("@acme/ui"); // barrel: exports has only "."

    const { violations } = await runCheck({ root: app, paths: ["src/app/page.tsx"] });
    expect(violations.map((v) => `${v.rule}: ${v.suggestion ?? ""}`)).toEqual([
      "no-unknown-variant: Allowed: default, destructive, outline, ghost, link. Need a new one? Run `designspec propose`.",
      "no-variant-override: Pick a size instead (default, sm, lg, icon), or propose a new one with `designspec propose`.",
      `prefer-ds-component: import { Button } from "@acme/ui"`,
    ]);
  });

  it("reads components of an npm design system from its type declarations", async () => {
    const pkg = path.join(root, "node_modules/@acme/kit");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@acme/kit", types: "dist/index.d.ts" }));
    writeFileSync(path.join(pkg, "dist/index.d.ts"), `export * from "./button";\nexport { Input } from "./input";\n`);
    writeFileSync(
      path.join(pkg, "dist/button.d.ts"),
      [
        `import * as React from "react";`,
        `import { type VariantProps } from "class-variance-authority";`,
        `declare const buttonVariants: (props?: ({`,
        `    variant?: "solid" | "soft" | "plain" | null | undefined;`,
        `    size?: "sm" | "md" | null | undefined;`,
        `} & import("class-variance-authority/types").ClassProp) | undefined) => string;`,
        `export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {`,
        `    asChild?: boolean;`,
        `}`,
        `export declare function Button({ className, variant, size, ...props }: ButtonProps): React.JSX.Element;`,
        `export { buttonVariants };`,
      ].join("\n"),
    );
    writeFileSync(
      path.join(pkg, "dist/input.d.ts"),
      `import * as React from "react";\ninterface InputProps { tone?: "default" | "invalid" }\nexport declare const Input: React.ForwardRefExoticComponent<InputProps & React.RefAttributes<HTMLInputElement>>;\nexport declare const Unused: () => null;\n`,
    );
    await init(root, { force: false, agents: false, baseline: false });
    setConfig({ uiPackages: ["@acme/kit"] });
    await sync(root);
    const spec = await loadSpec(root, await loadConfig(root));
    const kit = spec.components.filter((c) => c.import === "@acme/kit");
    expect(kit.map((c) => [c.name, c.variants[c.name], c.replaces])).toEqual([
      ["Button", { variant: ["solid", "soft", "plain"], size: ["sm", "md"] }, ["button"]],
      ["Input", { tone: ["default", "invalid"] }, ["input"]],
    ]);
    // Next to the local Button's button.md, not over it.
    expect(existsSync(path.join(root, "design/components/acme-kit-button.md"))).toBe(true);
    expect(existsSync(path.join(root, "design/components/button.md"))).toBe(true);

    writeFileSync(path.join(root, "src/app/kit.tsx"), `import { Button, Input } from "@acme/kit"\nexport default () => <><Button variant="ghost" /><Input tone="error" /></>\n`);
    const { violations } = await runCheck({ root, paths: ["src/app/kit.tsx"] });
    expect(violations.map((v) => v.message)).toEqual(['"ghost" is not a variant of Button.', '"error" is not a tone of Input.']);
  });
});

describe("scss and less", () => {
  it("reads $variables as tokens and checks .scss and .less files", async () => {
    mkdirSync(path.join(root, "src/styles"), { recursive: true });
    writeFileSync(path.join(root, "src/styles/_variables.scss"), "$brand: #1850ff;\n$black: #000 !default;\n$link: $brand;\n");
    writeFileSync(path.join(root, "src/styles/variables.less"), "@surface: #fafafa;\n");
    writeFileSync(
      path.join(root, "src/styles/card.scss"),
      [`@use "variables" as *;`, `.card {`, `  color: #1850ff;`, `  background: rgba($black, 0.5);`, `  border-color: rgba(0, 0, 0, 0.2);`, `  &:hover { color: $link; }`, `}`].join("\n"),
    );
    writeFileSync(path.join(root, "src/styles/panel.less"), `.panel {\n  background: #fafafa;\n  color: fade(@surface, 10%);\n}\n`);
    await init(root, { force: false, agents: false, baseline: false });
    const config = await loadConfig(root);
    expect(config.cssFiles).toEqual(["src/app/globals.css", "src/styles/_variables.scss", "src/styles/variables.less"]);
    const spec = await loadSpec(root, config);
    expect(spec.tokens.find((t) => t.code === "$link")).toMatchObject({ type: "color", value: "#1850ff" });
    expect(spec.tokens.find((t) => t.code === "$black")?.value).toBe("#000");
    expect(spec.tokens.find((t) => t.code === "@surface")).toMatchObject({ type: "color", value: "#fafafa" });

    const { violations } = await runCheck({ root, paths: ["src/styles"] });
    expect(violations.map((v) => `${v.file}:${v.line} ${v.suggestion}`)).toEqual([
      "src/styles/card.scss:3 Closest token: $brand.",
      // Translucent: the opaque $black isn't a substitute.
      "src/styles/card.scss:5 Use a color token. If none fits, run `designspec propose` to add one.",
      "src/styles/panel.less:2 Closest token: @surface.",
    ]);
  });
});

describe("component libraries", () => {
  function project(deps: Record<string, string>, theme: string, page: string) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(path.join(root, "src/app"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0", ...deps } }));
    writeFileSync(path.join(root, "src/theme.ts"), theme);
    writeFileSync(path.join(root, "src/app/page.tsx"), page);
  }
  const lines = (violations: Violation[]) => violations.map((v) => `${v.line}:${v.rule}:${v.suggestion}`);

  it("Chakra: theme tokens, semantic tokens with _dark, style props", async () => {
    project(
      { "@chakra-ui/react": "3.2.0" },
      `import { createSystem, defaultConfig } from "@chakra-ui/react"
export const system = createSystem(defaultConfig, {
  theme: {
    tokens: { colors: { brand: { 500: { value: "#1850ff" } } } },
    semanticTokens: { colors: { "fg.muted": { value: { base: "{colors.brand.500}", _dark: "#a1a1aa" } } } },
  },
})
`,
      `import { Box } from "@chakra-ui/react"
export default () => <Box bg="#1850ff" color="red.500" borderColor="brand.500" />
`,
    );
    await init(root, { force: false, agents: false, baseline: false });
    const config = await loadConfig(root);
    expect(config.presets).toEqual(["react", "chakra"]);
    expect(config.themeFiles).toEqual(["src/theme.ts"]);
    const spec = await loadSpec(root, config);
    expect(spec.tokens.find((t) => t.utility === "fg.muted")).toMatchObject({ value: "#1850ff", modes: { dark: "#a1a1aa" } });
    const { violations } = await runCheck({ root });
    expect(lines(violations)).toEqual([
      "2:no-hardcoded-color:Closest token: brand.500.",
      "2:no-palette-color:Use a theme color (e.g. brand.500, fg.muted). If none fits, run `designspec propose`.",
    ]);
  });

  it("Mantine: color arrays and the c prop", async () => {
    const scale = Array.from({ length: 10 }, (_, i) => `"#${(i + 1).toString(16).repeat(6)}"`).join(", ");
    project(
      { "@mantine/core": "8.0.0" },
      `import { createTheme } from "@mantine/core"\nexport const theme = createTheme({ colors: { brand: [${scale}] } })\n`,
      `import { Text } from "@mantine/core"\nexport default () => <Text c="#666666" bg="blue.6" color="brand.6" />\n`,
    );
    await init(root, { force: false, agents: false, baseline: false });
    const { violations } = await runCheck({ root });
    expect(lines(violations)).toEqual([
      "2:no-hardcoded-color:Closest token: brand.5.",
      "2:no-palette-color:Use a theme color (e.g. brand.0, brand.1, brand.2). If none fits, run `designspec propose`.",
    ]);
  });

  it("MUI: palette from a default-exported createTheme, sx", async () => {
    project(
      { "@mui/material": "7.0.0" },
      `import { createTheme } from "@mui/material/styles"\nexport default createTheme({ palette: { primary: { main: "#1976d2" } } })\n`,
      `import Box from "@mui/material/Box"\nexport default () => <Box sx={{ color: "#1976d2", bgcolor: "primary.main" }} />\n`,
    );
    await init(root, { force: false, agents: false, baseline: false });
    const { violations } = await runCheck({ root });
    expect(lines(violations)).toEqual(["2:no-hardcoded-color:Closest token: primary.main."]);
  });
});

describe("vue and svelte", () => {
  beforeEach(() => init(root, { force: false, agents: false, baseline: false }));

  it("checks Vue templates, bindings, scripts and style blocks", async () => {
    writeFileSync(
      path.join(root, "src/app/Settings.vue"),
      [
        `<script setup lang="ts">`,
        `import { Button } from "@/components/ui/button"`,
        `const tone = "bg-red-500"`,
        `</script>`,
        ``,
        `<template>`,
        `  <section class="flex gap-4 p-[13px]">`,
        `    <!-- <button>commented out</button> -->`,
        `    <Button variant="ghost2">Save</Button>`,
        `    <Button :size="'xl'" :class="['h-12', open && 'w-full']">Wide</Button>`,
        `    <button style="color: #e5484d">Cancel</button>`,
        `    <template v-if="open"><span class="text-[#1a1a1a]" /></template>`,
        `  </section>`,
        `</template>`,
        ``,
        `<style lang="scss" scoped>`,
        `.x { border-color: #ff0000; }`,
        `</style>`,
      ].join("\n"),
    );
    const { violations } = await runCheck({ root, paths: ["src/app/Settings.vue"] });
    expect(violations.map((v) => `${v.line}:${v.column}:${v.rule}`)).toEqual([
      // A plain string in the script (line 3) isn't a class list, as in .tsx files.
      "7:30:no-arbitrary-value",
      "9:22:no-unknown-variant",
      "10:21:no-unknown-variant", // :size="'xl'"
      "10:36:no-variant-override", // :class="['h-12', …]"
      "11:5:prefer-ds-component", // the commented-out <button> is skipped
      "11:27:no-hardcoded-color", // style="color: #e5484d"
      "12:40:no-hardcoded-color", // inside a nested <template v-if>
      "17:20:no-hardcoded-color", // <style lang="scss">
    ]);
  });

  it("checks Svelte markup and expressions", async () => {
    writeFileSync(
      path.join(root, "src/app/Card.svelte"),
      [
        `<script lang="ts">`,
        `  import { Button } from "@/components/ui/button"`,
        `  let open = false`,
        `</script>`,
        ``,
        `<div class="bg-zinc-100 {open ? 'p-4' : ''}">`,
        `  <Button variant="outline" size={"huge"} on:click={() => (open = !open)} />`,
        `  <input type="text" />`,
        `</div>`,
        ``,
        `<style>`,
        `  div { background: rgb(255 0 0); }`,
        `</style>`,
      ].join("\n"),
    );
    const { violations } = await runCheck({ root, paths: ["src/app/Card.svelte"] });
    expect(violations.map((v) => `${v.line}:${v.rule}`)).toEqual(["6:no-palette-color", "7:no-unknown-variant", "8:prefer-ds-component", "12:no-hardcoded-color"]);
  });
});

describe("agent tools", () => {
  it("sets up the tools the repo uses and keeps what's already in shared files", async () => {
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    mkdirSync(path.join(root, ".vscode"), { recursive: true });
    mkdirSync(path.join(root, ".github"), { recursive: true });
    writeFileSync(path.join(root, ".vscode/mcp.json"), JSON.stringify({ servers: { github: { type: "http", url: "https://example.com/mcp" } } }));
    writeFileSync(path.join(root, ".github/copilot-instructions.md"), "# Team rules\n\nUse pnpm.\n");

    await init(root, { force: false, agents: true, baseline: false });
    const read = (p: string) => readFileSync(path.join(root, p), "utf8");
    expect(read(".cursor/rules/designspec.mdc")).toMatch(/^---\ndescription: .+\nglobs: \*\*\/\*\.\{tsx,jsx,ts,js,vue,svelte,css,scss,less\}\nalwaysApply: false\n---\n/);
    expect(JSON.parse(read(".cursor/mcp.json")).mcpServers.designspec).toEqual({ type: "stdio", command: "npx", args: ["-y", "designspec", "mcp"] });
    expect(JSON.parse(read(".vscode/mcp.json")).servers).toEqual({
      github: { type: "http", url: "https://example.com/mcp" },
      designspec: { type: "stdio", command: "npx", args: ["-y", "designspec", "mcp"] },
    });
    expect(read(".github/copilot-instructions.md")).toMatch(/^# Team rules\n\nUse pnpm\.\n\n<!-- designspec:start -->\n# Building UI with the design system/);
    expect(existsSync(path.join(root, "GEMINI.md"))).toBe(false);

    // Re-running replaces the section instead of adding another one.
    await writeAgentFiles(root, await loadConfig(root), ["copilot", "gemini", "windsurf"]);
    expect(read(".github/copilot-instructions.md").match(/designspec:start/g)).toHaveLength(1);
    expect(JSON.parse(read(".gemini/settings.json")).mcpServers.designspec.command).toBe("npx");
    expect(read(".windsurf/rules/designspec.md")).toMatch(/^---\ntrigger: glob\nglobs: ".+"\n---\n/);
  });
});

describe("explore, apply, verify", () => {
  beforeEach(async () => {
    await init(root, { force: false, agents: false, baseline: false });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "button-xl");
  });

  it("verifies a proposal against its declared changes", async () => {
    await createProposal(root, "button-size-xl", { why: "Hero CTAs", what: "Button size xl", delta: "variants:\n  Button.size: { add: [xl] }" });
    edit("src/components/ui/button.tsx", 'icon: "size-9",', 'icon: "size-9",\n        xl: "h-12 px-8",');
    edit("src/app/globals.css", "  --border: oklch(0.922 0 0);\n}", "  --border: oklch(0.922 0 0);\n  --brand: #1850ff;\n}");

    let result = await apply(root, "button-size-xl");
    expect(result.implemented).toEqual(["variant add: Button.size=xl"]);
    expect(result.undeclared).toEqual(["token add: --brand"]);
    expect(result.tasks).toEqual({ done: 1, total: 4 }); // apply ticked its own task
    expect(result.ok).toBe(false);

    const proposal = path.join(root, "design/changes/button-size-xl/proposal.md");
    writeFileSync(proposal, readFileSync(proposal, "utf8").replace("variants:", "tokens:\n  add: [--brand]\nvariants:"));
    const tasks = path.join(root, "design/changes/button-size-xl/tasks.md");
    writeFileSync(tasks, readFileSync(tasks, "utf8").replaceAll("- [ ]", "- [x]"));
    result = await verifyProposal(root, "button-size-xl");
    expect(result).toMatchObject({ implemented: ["token add: --brand", "variant add: Button.size=xl"], missing: [], undeclared: [], ok: true });
  });

  it("reports declared changes that aren't in code", async () => {
    await createProposal(root, "add-toast", { why: "x", what: "y", delta: "components:\n  add: [Toast]" });
    const result = await verifyProposal(root, "add-toast");
    expect(result.missing).toEqual(["component add: Toast"]);
  });

  it("finds repeated workarounds that point at missing variants and tokens", async () => {
    writeFileSync(
      path.join(root, "src/app/cta.tsx"),
      [
        `import { Button } from "@/components/ui/button"`,
        `export const A = () => (`,
        `  <>`,
        `    <Button className="h-12 px-8">1</Button>`,
        `    <Button className="px-8 h-12">2</Button>`,
        `    <Button className="h-12 px-8">3</Button>`,
        `  </>`,
        `)`,
        `export const B = () => <><p className="text-[#1850ff]" /><p className="text-[#1850FF]" /></>`,
      ].join("\n"),
    );
    const result = await explore(root);
    expect(result.repeatedOverrides).toEqual([{ pattern: "Button.size: h-12 px-8", count: 3 }]);
    expect(result.repeatedValues).toContainEqual({ rule: "no-hardcoded-color", value: "text-[#1850ff]", count: 2 });
    expect(result.hotspots[0].file).toBe("src/app/page.tsx");
  });
});

describe("adoption", () => {
  it("measures components and colors that go through the design system", async () => {
    await init(root, { force: false, agents: false, baseline: true });
    const config = await loadConfig(root);
    const adoption = await measureAdoption(root, config, await loadSpec(root, config));
    // Fixture page: <Input>, <Button>×3 vs native <input type="email"> and <button>;
    // bg-destructive / text-primary-foreground… in components are excluded (UI dir), the page has 4 bypassing colors.
    expect(adoption.components).toEqual({ ds: 4, bypassed: 2 });
    expect(adoption.componentScore).toBe(67);
    expect(adoption.colors.bypassed).toBe(4);
    expect(adoption.score).toBeLessThan(100);
  });
});

describe("preview", () => {
  beforeEach(async () => {
    await init(root, { force: false, agents: false, baseline: false });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "brand");
  });

  it("draws every token in each mode and every component", async () => {
    const { file, changes } = await writePreview(root);
    expect(changes).toBeUndefined();
    expect(file).toBe(path.join(root, "design/preview.html"));
    expect(readFileSync(path.join(root, "design/.gitignore"), "utf8")).toBe("preview.html\n");
    const html = readFileSync(file, "utf8");
    // The default and dark values of --primary, each in its mode's variables and labels.
    expect(html).toMatch(/\.mode-0\{[^}]*--primary:oklch\(0\.205 0 0\);/);
    expect(html).toMatch(/\.mode-1\{[^}]*--primary:oklch\(0\.922 0 0\);/);
    expect(html).toContain('<button role="tab" aria-selected="false" data-mode="1">dark</button>');
    expect(html).toContain('<div class="box" style="border-radius:var(--radius-lg)"></div>');
    expect(html).toMatch(/<h3>Button<\/h3>[\s\S]*?<span class="opt default" title="default">default<\/span>/);
  });

  it("marks what changed since a base, also as a PR comment section", async () => {
    edit("src/components/ui/button.tsx", 'icon: "size-9",', 'icon: "size-9",\n        xl: "h-12 px-8",');
    edit("src/app/globals.css", "  --border: oklch(0.922 0 0);\n}", "  --border: oklch(0.922 0 0);\n  --brand: #1850ff;\n}");
    edit("src/app/globals.css", "--primary: oklch(0.205 0 0);", "--primary: #3446d4;");
    await sync(root);

    const { changes } = await writePreview(root, { base: "main" });
    expect(changes).toBe(3);
    const html = readFileSync(path.join(root, "design/preview.html"), "utf8");
    expect(html).toContain('<span class="opt added">xl</span>');
    expect(html).toMatch(/--brand<span class="badge added">added<\/span>/);

    const config = await loadConfig(root);
    const markdown = changesMarkdown(await specAt(root, config, "main"), await loadSpec(root, config));
    expect(markdown).toContain("### Design system changes (3)");
    expect(markdown).toContain("| changed | `--primary` | $\\color{#171717}{\\blacksquare}$ `oklch(0.205 0 0)`<br>$\\color{#e5e5e5}{\\blacksquare}$ `dark: oklch(0.922 0 0)` | $\\color{#3446d4}{\\blacksquare}$ `#3446d4`<br>");
    expect(markdown).toContain("| added | `--brand` |  | $\\color{#1850ff}{\\blacksquare}$ `#1850ff` |");
    expect(markdown).toContain('| added | `Button` |  | `size="xl"` |');
    expect(changesMarkdown(await loadSpec(root, config), await loadSpec(root, config))).toBe("");
  });

  it("groups tokens and resolves values per mode", () => {
    const token = (name: string, value: string, type: "color" | "dimension" | "other" = "other") => ({ name, value, type, cssVar: `--${name}` });
    expect(tokenGroup(token("radius-lg", "8px", "dimension"))).toBe("radius");
    expect(tokenGroup(token("text-sm", "0.875rem", "dimension"))).toBe("typography");
    expect(tokenGroup(token("font-sans", "Inter"))).toBe("typography");
    expect(tokenGroup(token("shadow-md", "0 1px 2px #0003"))).toBe("shadow");
    expect(tokenGroup(token("spacing-4", "16px", "dimension"))).toBe("spacing");
    const sidebar = { ...token("sidebar", "#fff", "color"), modes: { dark: "#111", "dark+palette=ocean": "#012" } };
    expect(valueIn(sidebar, "dark+palette=warm")).toBe("#111");
    expect(valueIn(sidebar, "dark+palette=ocean")).toBe("#012");
    expect(valueIn(sidebar, "palette=ocean")).toBe("#fff");
  });

  it("doesn't read numbers as colors", () => {
    expect(parseColor("400")).toBeUndefined();
    expect(parseColor("9999")).toBeUndefined();
    expect(parseColor("#400")).toBeDefined();
  });
});

describe("designspec skill", () => {
  it("has references matching docs/", () => {
    execFileSync("node", [path.join(import.meta.dirname, "../scripts/skill-references.mjs"), "--check"]);
  });

  it("only links to files that exist", () => {
    const dir = path.join(import.meta.dirname, "../skills/designspec");
    const links = [...readFileSync(path.join(dir, "SKILL.md"), "utf8").matchAll(/\]\((references\/[^)#]+)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(existsSync(path.join(dir, link)), link).toBe(true);
  });
});
