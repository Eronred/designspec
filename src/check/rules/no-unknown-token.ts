import { arbitraryValue, tokenizeClasses } from "../classes.js";
import { collectStyleProperties } from "../styles.js";
import { tokenReferenceChecker, VAR_REFERENCE } from "../token-refs.js";
import type { FileRule } from "../types.js";

// Tailwind v4 shorthand for `bg-[var(--x)]`: `bg-(--x)`.
const VAR_SHORTHAND = /^[a-z][a-z0-9-]*?-\((--[\w-]+)\)(?:\/\S+)?$/;

export const noUnknownToken: FileRule = {
  id: "no-unknown-token",
  description: "Disallow var(--x) references to tokens that don't exist (typos, removed tokens).",
  defaultLevel: "warn",
  runsInUiDir: true,
  check(ctx) {
    const exists = tokenReferenceChecker(ctx.config, ctx.spec, (ctx.options.allow as string[] | undefined) ?? []);
    const styles = collectStyleProperties(ctx.ast);
    const definedHere = ctx.definedVars;
    const report = (name: string, index: number) =>
      ctx.report(index, `Unknown token ${name}.`, "Check the name against design/tokens.json, or define the token first (`designspec propose`).");

    for (const classString of ctx.classStrings) {
      for (const token of tokenizeClasses(classString)) {
        const shorthand = VAR_SHORTHAND.exec(token.utility)?.[1];
        const names = shorthand ? [shorthand] : [...(arbitraryValue(token.utility)?.value.matchAll(VAR_REFERENCE) ?? [])].map((m) => m[1]);
        for (const name of names) if (!exists(name, definedHere)) report(name, token.index);
      }
    }
    for (const { value } of styles) {
      if (value.type !== "StringLiteral") continue;
      for (const match of value.value.matchAll(VAR_REFERENCE)) {
        if (!exists(match[1], definedHere)) report(match[1], value.start! + 1 + match.index!);
      }
    }
  },
};
