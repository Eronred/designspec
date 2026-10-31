import { appendFileSync } from "node:fs";
import pc from "picocolors";
import type { CheckResult } from "./check/index.js";
import type { Violation } from "./check/types.js";
import type { FigmaDiff } from "./figma.js";
import type { ReviewResult } from "./review.js";

export type Format = "pretty" | "json" | "github" | "markdown";

/**
 * `repoPrefix` is the project's path inside the git repository (e.g. `apps/web/`). GitHub places
 * annotations by repo-relative path, so in monorepos it must be prepended.
 */
export function report(result: CheckResult, format: Format, repoPrefix = ""): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  // PR comments are capped at 65k characters; the job summary keeps every row.
  if (format === "markdown") return markdownReport(result, repoPrefix, 100);
  if (format === "github") {
    writeStepSummary(result, repoPrefix);
    return [...result.violations.map((v) => githubAnnotation(v, repoPrefix)), pretty(result)].join("\n");
  }
  return pretty(result);
}

function pretty(result: CheckResult): string {
  const lines: string[] = [];
  const byFile = groupByFile(result.violations);
  for (const [file, violations] of byFile) {
    lines.push("", pc.underline(file));
    for (const v of violations) {
      const severity = v.severity === "error" ? pc.red("error") : pc.yellow("warn ");
      lines.push(`  ${pc.dim(`${v.line}:${v.column}`.padEnd(8))}${severity}  ${v.message}  ${pc.dim(v.rule)}`);
      if (v.suggestion) lines.push(`  ${" ".repeat(15)}${pc.cyan("↳")} ${pc.dim(v.suggestion)}`);
    }
  }
  const { errors, warnings } = count(result.violations);
  const baselined = result.baselined ? pc.dim(` · ${result.baselined} baselined`) : "";
  const files = pc.dim(` · ${result.filesChecked} files checked`);
  if (errors + warnings === 0) {
    lines.push(`${pc.green("✔")} No design system violations${files}${baselined}`);
  } else {
    const summary = `${errors + warnings} problem${errors + warnings === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`;
    lines.push("", `${errors ? pc.red("✖") : pc.yellow("⚠")} ${summary}${files}${baselined}`);
  }
  for (const n of result.notChecked ?? []) {
    lines.push(pc.yellow(`  Not checked: ${n.what} (${plural(n.files.length, "file")}): ${n.reason}`));
  }
  return lines.join("\n");
}

function notCheckedMarkdown(result: CheckResult, repoPrefix: string): string {
  if (!result.notChecked?.length) return "";
  const rows = result.notChecked.map((n) => `- **${n.what}** (${plural(n.files.length, "file")}, e.g. \`${repoPrefix}${n.files[0]}\`): ${n.reason}`);
  return `\n**Not checked**\n\n${rows.join("\n")}\n`;
}

/** Workflow command that GitHub renders as an inline annotation on the PR diff. */
function githubAnnotation(v: Violation, repoPrefix: string): string {
  const level = v.severity === "error" ? "error" : "warning";
  const props = `file=${escapeProperty(repoPrefix + v.file)},line=${v.line},col=${v.column},title=${escapeProperty(`designspec: ${v.rule}`)}`;
  const message = v.suggestion ? `${v.message}\n${v.suggestion}` : v.message;
  return `::${level} ${props}::${escapeData(message)}`;
}

function writeStepSummary(result: CheckResult, repoPrefix: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdownReport(result, repoPrefix));
}

/** Every problem as a Markdown table, for the job summary and the PR comment (annotations are capped at 10 per step). */
export function markdownReport(result: CheckResult, repoPrefix = "", maxRows = Infinity): string {
  const { errors, warnings } = count(result.violations);
  const title = `designspec${repoPrefix ? ` (${repoPrefix.replace(/\/$/, "")})` : ""}`;
  if (errors + warnings === 0) return `## ✅ ${title}\n\nNo design system problems in ${plural(result.filesChecked, "file")}.\n${notCheckedMarkdown(result, repoPrefix)}`;
  const rows = result.violations.slice(0, maxRows).map(
    (v) => `| ${v.severity === "error" ? "🔴" : "🟡"} | \`${repoPrefix}${v.file}:${v.line}\` | ${escapeCell(v.message)} | ${escapeCell(v.suggestion ?? "")} | \`${v.rule}\` |`,
  );
  const more = result.violations.length > maxRows ? `\n…and ${result.violations.length - maxRows} more in the job summary.\n` : "";
  return `## ${errors ? "❌" : "⚠️"} ${title}\n\n${plural(errors, "error")}, ${plural(warnings, "warning")} in ${plural(result.filesChecked, "file")}.\n\n| | Location | Problem | Fix | Rule |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n${more}${notCheckedMarkdown(result, repoPrefix)}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function count(violations: Violation[]): { errors: number; warnings: number } {
  const errors = violations.filter((v) => v.severity === "error").length;
  return { errors, warnings: violations.length - errors };
}

function groupByFile(violations: Violation[]): Map<string, Violation[]> {
  const map = new Map<string, Violation[]>();
  for (const v of violations) map.set(v.file, [...(map.get(v.file) ?? []), v]);
  return map;
}

/** AI review findings as non-blocking annotations, plus a job summary section. */
export function reportReview(result: ReviewResult, format: Format, repoPrefix = ""): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines: string[] = [];
  for (const f of result.findings) {
    const message = f.suggestion ? `${f.message}\n${f.suggestion}` : f.message;
    if (format === "github") {
      const props = `file=${escapeProperty(repoPrefix + f.file)},line=${f.line},title=${escapeProperty(`designspec AI review: ${f.rule}`)}`;
      lines.push(`::${f.severity === "warning" ? "warning" : "notice"} ${props}::${escapeData(message)}`);
    } else {
      lines.push(`${pc.underline(f.file)}:${f.line}  ${f.severity === "warning" ? pc.yellow("warn") : pc.blue("note")}  ${f.message}  ${pc.dim(f.rule)}`);
      if (f.suggestion) lines.push(`  ${pc.cyan("↳")} ${pc.dim(f.suggestion)}`);
    }
  }
  const status = result.skipped ?? `${result.findings.length} AI review finding${result.findings.length === 1 ? "" : "s"}.`;
  const u = result.usage;
  const usage = u ? ` (${u.inputTokens + u.cacheWriteTokens + u.cachedInputTokens} input tokens: ${u.cachedInputTokens} read from cache, ${u.cacheWriteTokens} written to cache; ${u.outputTokens} output)` : "";
  lines.push(format === "github" && result.skipped ? `::notice title=designspec AI review::${escapeData(result.skipped)}` : `${status}${pc.dim(usage)}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (format === "github" && summary) {
    const rows = result.findings.map((f) => `| ${f.severity === "warning" ? "🟡" : "🔵"} | \`${repoPrefix}${f.file}:${f.line}\` | ${escapeCell(f.message)} | ${escapeCell(f.suggestion)} |`);
    appendFileSync(
      summary,
      `\n## 🤖 designspec AI review\n\n${status} Suggestions only; never blocks the PR.\n${rows.length ? `\n| | Location | Finding | Suggestion |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n` : ""}`,
    );
  }
  return lines.join("\n");
}

function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Figma ↔ code comparison, for people (pretty), PRs (markdown) or tools (json). */
export function reportFigmaDiff(diff: FigmaDiff, format: "pretty" | "json" | "markdown"): string {
  if (format === "json") return JSON.stringify(diff, null, 2);
  const unmapped = Object.entries(diff.modeMap).flatMap(([collection, map]) =>
    Object.entries(map).filter(([, code]) => code.startsWith("?")).map(([mode]) => `${collection} / ${mode}`),
  );
  const total = diff.matches + diff.mismatches.length;
  const summary =
    `${diff.matches}/${total} values match` +
    (diff.unchecked ? `, ${diff.unchecked} not comparable (derived or relative values)` : "") +
    (diff.alternates.length ? `, ${diff.alternates.length} alternate values (${[...new Set(diff.alternates.map((a) => a.figmaName))].join(", ")})` : "");
  if (format === "markdown") {
    const rows = diff.mismatches.map((m) => `| \`${m.cssVar}\` | ${m.mode} | \`${m.figma}\` | \`${m.code}\`${m.codeResolved !== undefined && String(m.codeResolved) !== m.code ? ` (\`${m.codeResolved}\`)` : ""} |`);
    return [
      `## Figma ↔ code`,
      ``,
      summary + ".",
      ...(rows.length ? [``, `| Token | Mode | Figma | Code |`, `| --- | --- | --- | --- |`, ...rows] : []),
      ...(diff.onlyInFigma.length ? [``, `Only in Figma: ${diff.onlyInFigma.map((v) => `\`${v}\``).join(", ")}`] : []),
      ...(diff.onlyInCode.length ? [``, `Only in code: ${diff.onlyInCode.map((v) => `\`${v}\``).join(", ")}`] : []),
      ...(unmapped.length ? [``, `Unmapped Figma modes (set \`figma.modes\`): ${unmapped.join(", ")}`] : []),
      ``,
    ].join("\n");
  }
  const lines = diff.mismatches.map(
    (m) => `  ${m.cssVar.padEnd(28)} ${pc.dim(m.mode.padEnd(16))} figma ${String(m.figma).padEnd(10)} code ${m.code}${m.codeResolved !== undefined && String(m.codeResolved) !== m.code ? pc.dim(` (${m.codeResolved})`) : ""}`,
  );
  return [
    ...lines,
    ...(diff.onlyInFigma.length ? [`${pc.yellow("Only in Figma:")} ${diff.onlyInFigma.join(", ")}`] : []),
    ...(diff.onlyInCode.length ? [`${pc.yellow("Only in code:")} ${diff.onlyInCode.join(", ")}`] : []),
    ...(unmapped.length ? [`${pc.yellow("Unmapped Figma modes")} (set figma.modes in the config): ${unmapped.join(", ")}`] : []),
    `${diff.mismatches.length ? pc.yellow("⚠") : pc.green("✔")} ${summary}`,
  ].join("\n");
}
