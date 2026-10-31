import { existsSync } from "node:fs";
import path from "node:path";
import postcss, { type Root } from "postcss";
import less from "postcss-less";
import scss from "postcss-scss";

export const STYLESHEET = /\.(css|scss|less)$/;

/** Parses CSS, SCSS or Less by file extension. */
export function parseStylesheet(text: string, file: string): Root {
  if (file.endsWith(".scss")) return scss.parse(text, { from: file }) as Root;
  if (file.endsWith(".less")) return less.parse!(text, { from: file }) as Root;
  return postcss.parse(text, { from: file });
}

/**
 * Local files a stylesheet imports: `@import "./a.css"`, and in SCSS / Less also `@use "tokens"` and
 * `@forward`, resolving partials (`_tokens.scss`, `tokens/_index.scss`). Packages and `sass:` modules are skipped.
 */
export function stylesheetImports(root: Root, file: string): string[] {
  const preprocessor = /\.(scss|less)$/.exec(file)?.[1];
  const found: string[] = [];
  root.walkAtRules(/^(import|use|forward)$/, (rule) => {
    const target = /^(?:url\()?["']?([^"')\s]+)["']?\)?/.exec(rule.params)?.[1];
    if (!target || /^(sass:|~|https?:|\/\/)/.test(target)) return;
    if (!preprocessor && !target.startsWith(".") && !target.startsWith("/")) return;
    const resolved = resolveStylesheet(path.dirname(file), target, preprocessor);
    if (resolved) found.push(resolved);
  });
  return found;
}

function resolveStylesheet(dir: string, target: string, preprocessor: string | undefined): string | undefined {
  const base = path.resolve(dir, target);
  if (!preprocessor) return existsSync(base) ? base : undefined;
  const name = path.basename(base);
  const parent = path.dirname(base);
  const candidates = /\.(scss|less|css)$/.test(name)
    ? [base, path.join(parent, `_${name}`)]
    : [`${base}.${preprocessor}`, path.join(parent, `_${name}.${preprocessor}`), path.join(base, `_index.${preprocessor}`), path.join(base, `index.${preprocessor}`), `${base}.css`];
  return candidates.find((c) => existsSync(c));
}
