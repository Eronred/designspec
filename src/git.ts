import { execFileSync } from "node:child_process";
import { UserError } from "./config.js";

export interface GitDiff {
  /** Added line numbers per file; `"all"` for untracked files. */
  added: Map<string, Set<number> | "all">;
  /** Every changed path, including deleted ones. */
  changed: string[];
  /** Whether a project-relative path existed at the merge base. */
  existedAtBase(file: string): boolean;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** The project's path inside its git repository, e.g. `apps/web/`; empty at the repo root or outside git. */
export function repoPrefix(root: string): string {
  try {
    return git(root, ["rev-parse", "--show-prefix"]).trim();
  } catch {
    return "";
  }
}

/** Changes in the working tree relative to the merge base of `base` and HEAD (what a PR would show). */
export function diffAgainst(root: string, base: string): GitDiff {
  let mergeBase: string;
  try {
    mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  } catch (error) {
    throw new UserError(
      `Could not find a merge base between "${base}" and HEAD. In GitHub Actions, check out with \`fetch-depth: 0\`.\n${(error as { stderr?: string }).stderr ?? ""}`.trim(),
    );
  }
  const added = parseUnifiedDiff(git(root, ["diff", "--unified=0", "--no-color", "--no-ext-diff", "--relative", mergeBase]));
  const changed = git(root, ["diff", "--name-only", "--relative", mergeBase]).split("\n").filter(Boolean);
  for (const file of git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
    added.set(file, "all");
    changed.push(file);
  }
  const existedAtBase = (file: string) => {
    try {
      // `<rev>:./path` resolves relative to the current directory, which is the project root here.
      git(root, ["cat-file", "-e", `${mergeBase}:./${file}`]);
      return true;
    } catch {
      return false;
    }
  };
  return { added, changed, existedAtBase };
}

/** The unified diff (3 lines of context) of `files` since the merge base of `base` and HEAD. */
export function diffText(root: string, base: string, files: string[]): string {
  if (files.length === 0) return "";
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  return git(root, ["diff", "--unified=3", "--no-color", "--no-ext-diff", "--relative", mergeBase, "--", ...files]);
}

export function parseUnifiedDiff(patch: string): Map<string, Set<number> | "all"> {
  const result = new Map<string, Set<number> | "all">();
  let current: Set<number> | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = undefined;
        continue;
      }
      current = new Set();
      result.set(target.replace(/^b\//, ""), current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) current.add(start + i);
    }
  }
  return result;
}
