import { glob } from "tinyglobby";
import type { Config } from "./config.js";

/** Something in the project designspec can't check, so a clean result isn't mistaken for full coverage. */
export interface NotChecked {
  what: string;
  reason: string;
  files: string[];
}

interface ImportPattern {
  what: string;
  pattern: RegExp;
  reason: string;
}

// Libraries whose styling lives somewhere the rules don't look.
const IMPORT_PATTERNS: ImportPattern[] = [
  { what: "Panda CSS", pattern: /from\s+["'](?:@pandacss\/|styled-system\/)/, reason: "css() objects and tokens aren't checked" },
  { what: "vanilla-extract", pattern: /from\s+["']@vanilla-extract\//, reason: "style() objects and themes aren't checked" },
  { what: "StyleX", pattern: /from\s+["']@stylexjs\//, reason: "stylex.create() styles aren't checked" },
];

// File types the parser doesn't read.
const FILE_TYPES: Array<{ what: string; glob: string; reason: string }> = [
  { what: "Astro", glob: "**/*.astro", reason: ".astro files aren't checked" },
  { what: "Sass (indented syntax)", glob: "**/*.sass", reason: ".sass files aren't checked (.scss is)" },
];

/** Libraries used in a file's source that designspec can't check. */
export function unsupportedImports(text: string): ImportPattern[] {
  return IMPORT_PATTERNS.filter((p) => p.pattern.test(text));
}

export class CoverageCollector {
  private readonly found = new Map<string, NotChecked>();

  add(what: string, reason: string, file: string): void {
    const entry = this.found.get(what) ?? { what, reason, files: [] };
    if (!entry.files.includes(file)) entry.files.push(file);
    this.found.set(what, entry);
  }

  addSource(file: string, text: string): void {
    for (const p of unsupportedImports(text)) this.add(p.what, p.reason, file);
  }

  async addFileTypes(root: string, config: Config): Promise<void> {
    for (const type of FILE_TYPES) {
      for (const file of await glob(type.glob, { cwd: root, ignore: config.exclude })) this.add(type.what, type.reason, file);
    }
  }

  /** Everything found, or only what touches `files` (a pull request's changes). */
  result(files?: Set<string>): NotChecked[] {
    return [...this.found.values()]
      .map((entry) => ({ ...entry, files: files ? entry.files.filter((f) => files.has(f)) : entry.files }))
      .filter((entry) => entry.files.length > 0)
      .sort((a, b) => b.files.length - a.files.length);
  }
}
