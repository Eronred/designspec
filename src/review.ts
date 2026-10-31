import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { resolveFiles } from "./check/index.js";
import { type Config, loadConfig } from "./config.js";
import { diffAgainst, diffText } from "./git.js";
import { loadSpec, type Spec, specPaths } from "./spec.js";

export const DEFAULT_REVIEW_MODEL = "claude-opus-5-5";
/** Rendered diffs above this size are not reviewed rather than silently cut. */
const MAX_DIFF_CHARS = 400_000;

const FindingSchema = z.object({
  file: z.string().describe("Project-relative path exactly as in the diff header"),
  line: z.number().int().describe("New-file line number of an added line"),
  severity: z.enum(["warning", "notice"]).describe("warning: breaks a design rule; notice: a suggestion"),
  rule: z.string().describe("Short label, e.g. the rule from rules.md, 'duplicate-component' or 'new-pattern'"),
  message: z.string(),
  suggestion: z.string().describe("Concrete fix using the design system, or empty"),
});
const ReviewSchema = z.object({ findings: z.array(FindingSchema) });

export type ReviewFinding = z.infer<typeof FindingSchema>;

export interface ReviewResult {
  findings: ReviewFinding[];
  /** Why the review didn't run or was incomplete, e.g. a missing key or an oversized diff. */
  skipped?: string;
  usage?: { inputTokens: number; cacheWriteTokens: number; cachedInputTokens: number; outputTokens: number };
}

/** The slice of the Anthropic client the review uses, so tests can pass a fake. */
export type ReviewClient = Pick<Anthropic, "beta">;

const INSTRUCTIONS = `You review pull request diffs for consistency with this project's design system.

Deterministic checks already ran on this diff: hardcoded and palette colors, arbitrary values, unknown variants,
className overrides of variants, native elements instead of design system components, restricted imports, zones.
Do not repeat those. Look for what they cannot see:
- violations of the plain-language rules below,
- new components or markup that duplicate an existing design system component,
- a new pattern (layout, empty state, form, dialog) where the design system already has one,
- misuse of a component against its documented usage.

Report only problems you are confident about, on added lines (marked "+"), using the line number printed before
the "+". An empty list is a good result. Keep messages short and actionable, and name the design system component,
variant or token to use in "suggestion".`;

export async function runReview(root: string, options: { diffBase: string; model?: string; effort?: "low" | "medium" | "high"; client?: ReviewClient }): Promise<ReviewResult> {
  const config = await loadConfig(root);
  const diff = diffAgainst(root, options.diffBase);
  const files = await resolveFiles(root, config, undefined, diff);
  const rendered = renderDiff(diffText(root, options.diffBase, files));
  if (!rendered.text) return { findings: [] };
  if (rendered.text.length > MAX_DIFF_CHARS) {
    return { findings: [], skipped: `The diff is ${Math.round(rendered.text.length / 1000)}k characters, above the ${MAX_DIFF_CHARS / 1000}k review limit; AI review skipped.` };
  }

  let client = options.client;
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      return { findings: [], skipped: "No ANTHROPIC_API_KEY set; AI review skipped." };
    }
    client = new Anthropic();
  }

  const context = await designContext(root, config, await loadSpec(root, config));
  let response: Awaited<ReturnType<ReviewClient["beta"]["messages"]["parse"]>>;
  try {
    response = await client.beta.messages.parse({
      model: options.model ?? DEFAULT_REVIEW_MODEL,
      max_tokens: 16000,
      // A declined request is re-run on Anthropic's recommended fallback model instead of failing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // The design system part is identical across PRs in a repo, so it is cached; only the diff changes.
      system: [{ type: "text", text: `${INSTRUCTIONS}\n\n${context}`, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Review this diff:\n\n${rendered.text}` }],
      output_config: { effort: options.effort ?? "medium", format: betaZodOutputFormat(ReviewSchema) },
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return { findings: [], skipped: "ANTHROPIC_API_KEY was rejected; AI review skipped." };
    if (error instanceof Anthropic.RateLimitError) return { findings: [], skipped: "Rate limited by the Anthropic API; AI review skipped." };
    if (error instanceof Anthropic.APIError) return { findings: [], skipped: `Anthropic API error ${error.status ?? ""}: ${error.message}; AI review skipped.` };
    throw error;
  }

  const usage = {
    inputTokens: response.usage.input_tokens,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
  };
  if (response.stop_reason === "refusal") return { findings: [], skipped: "The model declined to review this diff.", usage };
  if (response.stop_reason === "max_tokens") return { findings: [], skipped: "The review was cut off by max_tokens; no findings reported.", usage };
  // `response` is declared outside the try, which widens the parse helper's inferred output type.
  const parsed = response.parsed_output as z.infer<typeof ReviewSchema> | null;
  if (!parsed) return { findings: [], skipped: "The review response could not be parsed.", usage };

  // Only keep findings that point at lines this PR added.
  const findings = parsed.findings.filter((f) => rendered.added.get(f.file)?.has(f.line));
  return { findings, usage };
}

/**
 * Prints each added line with its new-file line number so the model reads line numbers instead of counting:
 *
 *   ### src/app/page.tsx
 *     12 | <div>
 *     13 + <button>Save</button>
 *        - <Button>Save</Button>
 */
export function renderDiff(patch: string): { text: string; added: Map<string, Set<number>> } {
  const out: string[] = [];
  const added = new Map<string, Set<number>>();
  let file: string | undefined;
  let line = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      file = undefined;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? undefined : target.replace(/^b\//, "");
      if (file) {
        added.set(file, new Set());
        out.push("", `### ${file}`);
      }
      continue;
    }
    if (!file || raw.startsWith("--- ") || raw.startsWith("index ") || raw.startsWith("\\")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      out.push("     ...");
      continue;
    }
    if (raw.startsWith("+")) {
      added.get(file)?.add(line);
      out.push(`${String(line).padStart(6)} + ${raw.slice(1)}`);
      line++;
    } else if (raw.startsWith("-")) {
      out.push(`       - ${raw.slice(1)}`);
    } else if (raw.startsWith(" ")) {
      out.push(`${String(line).padStart(6)} | ${raw.slice(1)}`);
      line++;
    }
  }
  return { text: out.join("\n").trim(), added };
}

/** A compact, deterministic summary of the design system for the cached system prompt. */
async function designContext(root: string, config: Config, spec: Spec): Promise<string> {
  const rulesFile = path.join(specPaths(root, config).dir, "rules.md");
  const rules = existsSync(rulesFile) ? (await readFile(rulesFile, "utf8")).replace(/<!--[\s\S]*?-->/g, "").trim() : "";
  const components = spec.components.map((c) => {
    const variants = Object.entries(c.variants[c.name] ?? Object.values(c.variants)[0] ?? {})
      .map(([prop, values]) => `${prop}: ${values.join("|")}`)
      .join("; ");
    const docs = c.body.replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```/g, "").replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 300);
    // Exports keep suggestions to parts that exist (DialogContent, not an imagined DialogHeader).
    return `- ${c.name} (${c.import}; exports ${c.exports.join(", ")})${variants ? ` — ${variants}` : ""}${c.replaces.length ? ` — replaces ${c.replaces.join(", ")}` : ""}${docs ? ` — ${docs}` : ""}`;
  });
  const tokens = ["color", "dimension", "other"].map((type) => {
    const names = spec.tokens.filter((t) => t.type === type).map((t) => t.code ?? t.utility ?? t.name);
    return names.length ? `${type}: ${names.join(", ")}` : "";
  });
  const zones = config.zones.map((z) => `- ${z.name}: ${z.files.join(", ")}${z.denyTokens ? `; not allowed: ${z.denyTokens.join(", ")}` : ""}${z.allowTokens ? `; only: ${z.allowTokens.join(", ")}` : ""}`);
  return [
    "## Design rules",
    rules || "(none written)",
    "## Components",
    ...components,
    "## Tokens",
    ...tokens.filter(Boolean),
    ...(zones.length ? ["## Zones", ...zones] : []),
  ].join("\n");
}
