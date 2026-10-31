import type { Config } from "../config.js";
import type { Spec } from "../spec.js";
import { TAILWIND_PALETTE } from "../tailwind-palette.js";

// Tailwind v4 theme namespaces; their variables are defined by Tailwind or the project's @theme.
const TAILWIND_NAMESPACES = /^--(spacing|radius|font|text|leading|tracking|shadow|inset-shadow|drop-shadow|blur|perspective|aspect|ease|animate|breakpoint|container|default)(-|$)/;
const LIBRARY_VARS = ["--tw-", "--radix-", "--base-ui-"];
// Set at runtime by Base UI on positioners, popups and panels.
const BASE_UI_VARS = ["--anchor-", "--available-", "--transform-origin", "--active-tab-", "--accordion-panel-", "--collapsible-panel-", "--positioner-", "--popup-", "--nested-dialogs", "--scroll-area-"];

/** Decides whether `var(--name)` points at something that exists. */
export function tokenReferenceChecker(config: Config, spec: Spec, allow: string[] = []) {
  const known = new Set(spec.tokens.flatMap((t) => (t.cssVar ? [t.cssVar] : [])));
  const utilities = new Set(spec.tokens.flatMap((t) => (t.utility ? [t.utility] : [])));
  const tailwind = config.presets.includes("tailwind-v4");
  return (name: string, definedHere: Set<string>): boolean => {
    if (known.has(name) || definedHere.has(name)) return true;
    if (LIBRARY_VARS.some((prefix) => name.startsWith(prefix)) || allow.some((prefix) => name.startsWith(prefix.replace(/\*$/, "")))) return true;
    if (config.presets.includes("base-ui") && BASE_UI_VARS.some((prefix) => name.startsWith(prefix))) return true;
    if (!tailwind) return false;
    // `--color-primary` is the @theme alias of `--primary`; `--color-red-500` is Tailwind's palette.
    const color = /^--color-(.+)$/.exec(name)?.[1];
    if (color) return utilities.has(color) || color in TAILWIND_PALETTE || color === "white" || color === "black";
    return TAILWIND_NAMESPACES.test(name);
  };
}

export const VAR_REFERENCE = /var\(\s*(--[\w-]+)/g;

// `--x: 1` in CSS, `"--x": 1` in style objects, `[--x:2rem]` in Tailwind classes.
const VAR_DEFINITION = /(?:^|[\s{;"'`[(])(--[\w-]+)\s*["'`]?\s*:/gm;

/** Custom properties a file defines, so `var(--x)` defined in another file isn't reported as unknown. */
export function scanDefinedVars(text: string): string[] {
  return [...text.matchAll(VAR_DEFINITION)].map((m) => m[1]);
}
