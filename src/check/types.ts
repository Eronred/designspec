import type { File } from "@babel/types";
import type { Config, RuleLevel } from "../config.js";
import type { SourceText } from "../source.js";
import type { Spec } from "../spec.js";
import type { ClassString } from "./classes.js";
import type { ImportBinding } from "./imports.js";

export type Severity = "error" | "warn";

export interface Violation {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  message: string;
  suggestion?: string;
}

export interface RuleContext {
  /** Project-relative POSIX path. */
  file: string;
  source: SourceText;
  ast: File;
  config: Config;
  spec: Spec;
  options: Record<string, unknown>;
  classStrings: ClassString[];
  imports: ImportBinding[];
  /** Custom properties defined anywhere in the project (CSS, style objects, `[--x:...]` classes). */
  definedVars: Set<string>;
  report(index: number, message: string, suggestion?: string): void;
}

export interface FileRule {
  id: string;
  description: string;
  defaultLevel: RuleLevel;
  /** Whether the rule also runs on the design system's own UI directory. */
  runsInUiDir: boolean;
  enabled?(config: Config): boolean;
  /** What `enabled` waits for, for `designspec doctor`: "a Tailwind preset". */
  needs?: string;
  /** Why the rule has nothing to check with this spec (e.g. no variants), for `designspec doctor`. */
  idleReason?(spec: Spec): string | undefined;
  check(ctx: RuleContext): void;
}
