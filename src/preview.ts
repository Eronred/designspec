import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatHex } from "culori";
import { parseColor } from "./color.js";
import { loadConfig } from "./config.js";
import { type ComponentSpec, loadSpec, type Spec, type Token } from "./spec.js";
import { specAt } from "./workflow.js";

export interface PreviewOptions {
  title: string;
  /** The spec before a change (a PR's base): changes are marked, and removed items listed. */
  before?: Spec;
}

type Group = "color" | "typography" | "spacing" | "radius" | "shadow" | "motion" | "other";

const GROUPS: Array<{ id: Group; title: string }> = [
  { id: "color", title: "Colors" },
  { id: "typography", title: "Typography" },
  { id: "spacing", title: "Spacing & sizes" },
  { id: "radius", title: "Radius" },
  { id: "shadow", title: "Shadows" },
  { id: "motion", title: "Motion" },
  { id: "other", title: "Other tokens" },
];

/** Which section of the preview a token belongs in, from its type and name. */
export function tokenGroup(token: Token): Group {
  const name = (token.code ?? token.cssVar ?? token.name).replace(/^(--|\$|@)/, "").toLowerCase();
  if (token.type === "color") return "color";
  if (/(^|[.-])(radius|radii|rounded)/.test(name)) return "radius";
  if (/(^|[.-])(shadow|shadows|elevation|drop-shadow)/.test(name)) return "shadow";
  if (/(^|[.-])(animate|animation|ease|duration|transition)/.test(name)) return "motion";
  if (/^(font|fonts|text|leading|tracking|line-?height|letter-?spacing|typography|fontsizes?|fontweights?|lineheights?)([.-]|$)/.test(name)) return "typography";
  if (token.type === "dimension") return "spacing";
  return "other";
}

/** A token's value in a mode such as `dark+palette=ocean`: the most specific mode it defines, else its default. */
export function valueIn(token: Token, mode: string): string {
  if (!mode) return token.value;
  const want = new Set(mode.split("+"));
  let best = token.value;
  let size = 0;
  for (const [key, value] of Object.entries(token.modes ?? {})) {
    const parts = key.split("+");
    if (parts.length > size && parts.every((p) => want.has(p))) {
      best = value;
      size = parts.length;
    }
  }
  return best;
}

const tokenKey = (t: Token) => t.cssVar ?? t.code ?? t.name;
const label = (t: Token) => t.cssVar ?? t.code ?? t.name;

/** The CSS variable a token is drawn with: its own, or a stand-in for tokens that live in JS. */
function drawVar(token: Token): string {
  return token.cssVar ?? `--ds-${token.name.replace(/[^\w-]/g, "-")}`;
}

/** React Native lengths are unitless numbers. */
function cssValue(token: Token, value: string): string {
  return token.type === "dimension" && /^-?\d+(\.\d+)?$/.test(value.trim()) && value.trim() !== "0" ? `${value.trim()}px` : value;
}

interface TokenChange {
  status: "added" | "changed";
  before?: Token;
}

interface Changes {
  tokens: Map<string, TokenChange>;
  removedTokens: Token[];
  components: Map<string, { added: boolean; variants: Array<{ prop: string; value: string; status: "added" | "removed" }> }>;
  removedComponents: ComponentSpec[];
  count: number;
}

/** Everything that differs between two specs, with the before/after values to show. */
export function previewChanges(before: Spec, after: Spec): Changes {
  const changes: Changes = { tokens: new Map(), removedTokens: [], components: new Map(), removedComponents: [], count: 0 };
  const old = new Map(before.tokens.map((t) => [tokenKey(t), t]));
  const now = new Set(after.tokens.map(tokenKey));
  for (const token of after.tokens) {
    const was = old.get(tokenKey(token));
    if (!was) changes.tokens.set(tokenKey(token), { status: "added" });
    else if (was.value !== token.value || JSON.stringify(was.modes ?? {}) !== JSON.stringify(token.modes ?? {})) changes.tokens.set(tokenKey(token), { status: "changed", before: was });
  }
  changes.removedTokens = before.tokens.filter((t) => !now.has(tokenKey(t)));

  const oldComponents = new Map(before.components.map((c) => [c.name, c]));
  const names = new Set(after.components.map((c) => c.name));
  for (const component of after.components) {
    const was = oldComponents.get(component.name);
    if (!was) {
      changes.components.set(component.name, { added: true, variants: [] });
      continue;
    }
    const variants: Array<{ prop: string; value: string; status: "added" | "removed" }> = [];
    const nowProps = primaryVariants(component);
    const wasProps = primaryVariants(was);
    for (const prop of new Set([...Object.keys(nowProps), ...Object.keys(wasProps)])) {
      for (const value of nowProps[prop] ?? []) if (!(wasProps[prop] ?? []).includes(value)) variants.push({ prop, value, status: "added" });
      for (const value of wasProps[prop] ?? []) if (!(nowProps[prop] ?? []).includes(value)) variants.push({ prop, value, status: "removed" });
    }
    if (variants.length) changes.components.set(component.name, { added: false, variants });
  }
  changes.removedComponents = before.components.filter((c) => !names.has(c.name));
  changes.count = changes.tokens.size + changes.removedTokens.length + changes.removedComponents.length + [...changes.components.values()].reduce((n, c) => n + (c.added ? 1 : c.variants.length), 0);
  return changes;
}

/** The variants of the component's own export (`Button`), else of its first export that has any. */
function primaryVariants(component: ComponentSpec): Record<string, string[]> {
  return component.variants[component.name] ?? Object.values(component.variants)[0] ?? {};
}

function primaryDefaults(component: ComponentSpec): Record<string, string> {
  return component.defaults[component.name] ?? Object.values(component.defaults)[0] ?? {};
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Safe inside a <style> block and a declaration value. */
const cssSafe = (s: string) => s.replace(/</g, "\\3c ").replace(/[;{}]/g, "");

/**
 * A single self-contained HTML page of the design system: every token drawn with its real value in each
 * mode, and every component with its variants. With `before`, what changed is marked.
 */
export function renderPreview(spec: Spec, options: PreviewOptions): string {
  const modes = ["", ...new Set(spec.tokens.flatMap((t) => Object.keys(t.modes ?? {})))];
  const changes = options.before ? previewChanges(options.before, spec) : undefined;
  const background = spec.tokens.find((t) => t.type === "color" && (t.utility ?? t.name) === "background");
  const foreground = spec.tokens.find((t) => t.type === "color" && (t.utility ?? t.name) === "foreground");

  // Each mode sets every token's variable on the token area, so aliases (`var(--radius)`) resolve as in the app.
  const modeCss = modes
    .map((mode, i) => `.mode-${i}{${spec.tokens.map((t) => `${drawVar(t)}:${cssSafe(cssValue(t, valueIn(t, mode)))};`).join("")}}`)
    .join("\n");
  // Only the active mode's value labels are shown.
  const labelCss = modes.map((_, i) => `.mode-${i} .v:not(.v${i}){display:none}`).join("\n");
  const surface = background ? `background:var(${drawVar(background)});${foreground ? `color:var(${drawVar(foreground)});` : ""}` : "";

  const values = (token: Token) => {
    if (!token.modes || Object.keys(token.modes).length === 0) return `<code class="val">${escape(token.value)}</code>`;
    return modes.map((mode, i) => `<code class="val v v${i}">${escape(valueIn(token, mode))}</code>`).join("");
  };
  const badge = (token: Token) => {
    const change = changes?.tokens.get(tokenKey(token));
    if (!change) return "";
    const was = change.before ? ` title="was ${escape(change.before.value)}"` : "";
    return `<span class="badge ${change.status}"${was}>${change.status}</span>`;
  };
  const tokenData = (token: Token) => `data-search="${escape(`${label(token)} ${token.utility ?? ""} ${token.value}`.toLowerCase())}"`;

  const sections: string[] = [];
  const nav: string[] = [];

  if (changes) {
    nav.push(`<a href="#changes">Changes <span class="count">${changes.count}</span></a>`);
    sections.push(renderChanges(changes, spec));
  }

  for (const group of GROUPS) {
    const tokens = spec.tokens.filter((t) => tokenGroup(t) === group.id);
    if (!tokens.length) continue;
    nav.push(`<a href="#${group.id}">${group.title} <span class="count">${tokens.length}</span></a>`);
    let body: string;
    if (group.id === "color") {
      body = `<div class="swatches">${tokens
        .map(
          (t) =>
            `<div class="swatch" ${tokenData(t)}><div class="chip" style="background:var(${drawVar(t)})"></div><div class="meta"><div class="name">${escape(label(t))}${badge(t)}</div>${t.utility && t.utility !== label(t).replace(/^--/, "") ? `<div class="util">${escape(t.utility)}</div>` : ""}${values(t)}</div></div>`,
        )
        .join("")}</div>`;
    } else {
      body = `<div class="rows">${tokens.map((t) => `<div class="row" ${tokenData(t)}><div class="sample">${sample(group.id, t)}</div><div class="meta"><div class="name">${escape(label(t))}${badge(t)}</div>${values(t)}</div></div>`).join("")}</div>`;
    }
    sections.push(`<section id="${group.id}" class="tokens"><h2>${group.title}</h2>${body}</section>`);
  }

  if (spec.components.length) {
    nav.push(`<a href="#components">Components <span class="count">${spec.components.length}</span></a>`);
    sections.push(
      `<section id="components"><h2>Components</h2><div class="components">${spec.components.map((c) => renderComponent(c, changes)).join("")}</div></section>`,
    );
  }

  const modeTabs =
    modes.length > 1
      ? `<div class="modes" role="tablist" aria-label="Mode">${modes.map((m, i) => `<button role="tab" aria-selected="${i === 0}" data-mode="${i}">${escape(m || "default")}</button>`).join("")}</div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)}</title>
<style>
:root{--p-bg:#fbfaf8;--p-fg:#1c1b19;--p-muted:#6b675f;--p-line:#e4e0d8;--p-panel:#f3f0ea;--p-accent:#3446d4;--p-add:#1f7a4d;--p-change:#a15c07;--p-remove:#b42318;--p-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--p-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{--p-bg:#121212;--p-fg:#ece9e3;--p-muted:#9d988e;--p-line:#2b2a27;--p-panel:#1b1a18;--p-accent:#8f9bff;--p-add:#5fc493;--p-change:#e0a24a;--p-remove:#f97066}}
*{box-sizing:border-box}
body{margin:0;background:var(--p-bg);color:var(--p-fg);font:14px/1.5 var(--p-sans)}
header{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 20px;background:var(--p-bg);border-bottom:1px solid var(--p-line)}
header h1{font-size:15px;margin:0 8px 0 0}
input[type=search]{font:inherit;color:inherit;background:var(--p-panel);border:1px solid var(--p-line);border-radius:6px;padding:6px 10px;width:220px;max-width:100%}
.modes{display:flex;flex-wrap:wrap;gap:4px}
.modes button{font:12px var(--p-mono);color:var(--p-muted);background:none;border:1px solid var(--p-line);border-radius:4px;padding:4px 8px;cursor:pointer}
.modes button[aria-selected=true]{color:var(--p-fg);background:var(--p-panel)}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--p-accent);outline-offset:2px}
.layout{display:grid;grid-template-columns:200px minmax(0,1fr)}
nav{position:sticky;top:57px;align-self:start;padding:20px;display:flex;flex-direction:column;gap:4px}
nav a{color:var(--p-muted);text-decoration:none}
nav a:hover{color:var(--p-fg)}
.count{font:11px var(--p-mono);color:var(--p-muted)}
main{padding:20px;min-width:0}
@media (max-width:720px){.layout{grid-template-columns:1fr}nav{position:static;flex-direction:row;flex-wrap:wrap;gap:4px 12px;padding:12px 16px 0}main{padding:16px}}
section{margin-bottom:40px;scroll-margin-top:70px}
h2{font:600 12px/1 var(--p-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--p-muted);margin:0 0 16px}
.tokens{padding:16px;border:1px solid var(--p-line);border-radius:8px;${surface}}
.name{font:500 13px var(--p-mono);word-break:break-all}
.util,.val{display:block;font:12px var(--p-mono);opacity:.7;word-break:break-all;background:none}
.swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.chip{height:56px;border-radius:6px;border:1px solid rgba(127,127,127,.25);margin-bottom:6px}
.rows{display:flex;flex-direction:column;gap:10px}
.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,260px);gap:16px;align-items:center;padding-bottom:10px;border-bottom:1px solid rgba(127,127,127,.15)}
@media (max-width:560px){.row{grid-template-columns:1fr}}
.sample{min-width:0;overflow:hidden}
.bar{height:12px;background:currentColor;opacity:.5;border-radius:2px;max-width:100%}
.box{width:64px;height:48px;border:2px solid currentColor;opacity:.7}
.card{width:120px;height:56px;border-radius:8px;background:var(--p-bg)}
.badge{font:600 10px/1 var(--p-mono);text-transform:uppercase;letter-spacing:.06em;margin-left:6px;padding:2px 5px;border-radius:3px;vertical-align:middle;color:#fff}
.badge.added{background:var(--p-add)}.badge.changed{background:var(--p-change)}.badge.removed{background:var(--p-remove)}
.components{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.component{border:1px solid var(--p-line);border-radius:8px;padding:14px;min-width:0}
.component h3{margin:0 0 4px;font-size:15px}
.component .import{font:12px var(--p-mono);color:var(--p-muted);word-break:break-all}
.component p{margin:8px 0 0;color:var(--p-muted)}
.props{margin:10px 0 0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 10px;font-size:12px}
.props dt{font-family:var(--p-mono);color:var(--p-muted)}
.props dd{margin:0;display:flex;flex-wrap:wrap;gap:4px}
.opt{font:12px var(--p-mono);padding:1px 6px;border:1px solid var(--p-line);border-radius:4px}
.opt.default{border-color:var(--p-accent);color:var(--p-accent)}
.opt.added{border-color:var(--p-add);color:var(--p-add)}
.opt.removed{border-color:var(--p-remove);color:var(--p-remove);text-decoration:line-through}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--p-line);vertical-align:top}
th{font-weight:500;color:var(--p-muted)}
td code{font:12px var(--p-mono)}
.dot{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid rgba(127,127,127,.3);vertical-align:-2px;margin-right:6px}
.hidden{display:none!important}
.empty{color:var(--p-muted)}
${modeCss}
${labelCss}
</style>
</head>
<body>
<header>
<h1>${escape(options.title)}</h1>
<input type="search" id="search" placeholder="Filter tokens and components" aria-label="Filter tokens and components">
${modeTabs}
</header>
<div class="layout">
<nav aria-label="Sections">${nav.join("")}</nav>
<main id="root" class="mode-0">
${sections.join("\n") || `<p class="empty">The spec is empty. Run <code>designspec sync</code>.</p>`}
</main>
</div>
<script>
const root = document.getElementById("root");
document.querySelectorAll("[data-mode]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll("[data-mode]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
  root.className = "mode-" + tab.dataset.mode;
}));
document.getElementById("search").addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll("[data-search]").forEach((el) => el.classList.toggle("hidden", !!query && !el.dataset.search.includes(query)));
  document.querySelectorAll("main section").forEach((section) => {
    const items = section.querySelectorAll("[data-search]");
    section.classList.toggle("hidden", items.length > 0 && [...items].every((el) => el.classList.contains("hidden")));
  });
});
</script>
</body>
</html>
`;
}

function sample(group: Group, token: Token): string {
  const v = `var(${drawVar(token)})`;
  const name = (token.code ?? token.cssVar ?? token.name).replace(/^(--|\$|@)/, "").toLowerCase();
  switch (group) {
    case "radius":
      return `<div class="box" style="border-radius:${v}"></div>`;
    case "shadow":
      return `<div class="card" style="box-shadow:${v}"></div>`;
    case "spacing":
      return `<div class="bar" style="width:${v}"></div>`;
    case "typography": {
      const text = "The quick brown fox jumps over the lazy dog";
      if (/line-?height|leading/.test(name)) return `<div style="line-height:${v};max-width:220px">${text}</div>`;
      if (/tracking|letter-?spacing/.test(name)) return `<div style="letter-spacing:${v}">${text}</div>`;
      if (/weight/.test(name) || /^\d{3}$/.test(token.value.trim())) return `<div style="font-weight:${v}">${text}</div>`;
      if (/size|^text|^fontsizes?/.test(name) || token.type === "dimension") return `<div style="font-size:${v};white-space:nowrap">Aa ${text}</div>`;
      return `<div style="font-family:${v};font-size:18px">${text}</div>`;
    }
    default:
      return `<code class="val">${escape(token.value)}</code>`;
  }
}

function renderComponent(component: ComponentSpec, changes?: Changes): string {
  const change = changes?.components.get(component.name);
  const variants = primaryVariants(component);
  const defaults = primaryDefaults(component);
  const removed = (prop: string) => (change?.variants ?? []).filter((v) => v.prop === prop && v.status === "removed").map((v) => v.value);
  const props = [...new Set([...Object.keys(variants), ...(change?.variants ?? []).map((v) => v.prop)])]
    .map((prop) => {
      const options = [...(variants[prop] ?? []), ...removed(prop)].map((value) => {
        const status = change?.variants.find((v) => v.prop === prop && v.value === value)?.status;
        const cls = ["opt", value === defaults[prop] ? "default" : "", status ?? ""].filter(Boolean).join(" ");
        return `<span class="${cls}"${value === defaults[prop] ? ' title="default"' : ""}>${escape(value)}</span>`;
      });
      return `<dt>${escape(prop)}</dt><dd>${options.join("")}</dd>`;
    })
    .join("");
  const replaces = component.replaces.length ? `<dt>replaces</dt><dd>${component.replaces.map((r) => `<span class="opt">&lt;${escape(r)}&gt;</span>`).join("")}</dd>` : "";
  const description = describe(component.body);
  const search = escape(`${component.name} ${component.import} ${component.exports.join(" ")}`.toLowerCase());
  return `<article class="component" data-search="${search}"><h3>${escape(component.name)}${change?.added ? '<span class="badge added">added</span>' : ""}</h3><div class="import">${escape(component.import)}</div>${description ? `<p>${escape(description)}</p>` : ""}${props || replaces ? `<dl class="props">${props}${replaces}</dl>` : ""}</article>`;
}

/** The first paragraph a person wrote in the component's doc, without headings, comments or code. */
function describe(body: string): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("|") && !p.startsWith("-"));
  return text ? text.replace(/[*_`]/g, "").slice(0, 280) : "";
}

function renderChanges(changes: Changes, spec: Spec): string {
  if (changes.count === 0) return `<section id="changes"><h2>Changes</h2><p class="empty">No design system changes.</p></section>`;
  const rows: string[] = [];
  const valueCell = (token: Token | undefined) => {
    if (!token) return "";
    const modes = Object.entries(token.modes ?? {});
    return `${dot(token.value)}<code>${escape(token.value)}</code>${modes.map(([m, v]) => `<br>${dot(v)}<code>${escape(m)}: ${escape(v)}</code>`).join("")}`;
  };
  for (const token of spec.tokens) {
    const change = changes.tokens.get(tokenKey(token));
    if (change) rows.push(`<tr><td><span class="badge ${change.status}">${change.status}</span></td><td><code>${escape(label(token))}</code></td><td>${valueCell(change.before)}</td><td>${valueCell(token)}</td></tr>`);
  }
  for (const token of changes.removedTokens) rows.push(`<tr><td><span class="badge removed">removed</span></td><td><code>${escape(label(token))}</code></td><td>${valueCell(token)}</td><td></td></tr>`);
  for (const [name, change] of changes.components) {
    if (change.added) rows.push(`<tr><td><span class="badge added">added</span></td><td><code>${escape(name)}</code></td><td></td><td>component</td></tr>`);
    for (const v of change.variants) rows.push(`<tr><td><span class="badge ${v.status}">${v.status}</span></td><td><code>${escape(name)}</code></td><td>${v.status === "removed" ? `<code>${escape(v.prop)}="${escape(v.value)}"</code>` : ""}</td><td>${v.status === "added" ? `<code>${escape(v.prop)}="${escape(v.value)}"</code>` : ""}</td></tr>`);
  }
  for (const component of changes.removedComponents) rows.push(`<tr><td><span class="badge removed">removed</span></td><td><code>${escape(component.name)}</code></td><td>component</td><td></td></tr>`);
  return `<section id="changes"><h2>Changes</h2><table><thead><tr><th></th><th>Item</th><th>Before</th><th>After</th></tr></thead><tbody>${rows.join("")}</tbody></table></section>`;
}

function dot(value: string): string {
  const color = parseColor(value);
  return color ? `<span class="dot" style="background:${escape(formatHex(color) ?? "transparent")}"></span>` : "";
}

/** The changes as a PR comment section; empty when nothing changed. Colors are drawn with GitHub's math rendering. */
export function changesMarkdown(before: Spec, after: Spec, previewUrl?: string): string {
  const changes = previewChanges(before, after);
  if (changes.count === 0) return "";
  const swatch = (value: string) => {
    const color = parseColor(value);
    const hex = color ? formatHex(color) : undefined;
    return hex ? `$\\color{${hex}}{\\blacksquare}$ ` : "";
  };
  const show = (token?: Token) => {
    if (!token) return "";
    const modes = Object.entries(token.modes ?? {});
    return [`${swatch(token.value)}\`${token.value}\``, ...modes.map(([m, v]) => `${swatch(v)}\`${m}: ${v}\``)].join("<br>");
  };
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [`### Design system changes (${changes.count})`, "", "| | Item | Before | After |", "| --- | --- | --- | --- |"];
  for (const token of after.tokens) {
    const change = changes.tokens.get(tokenKey(token));
    if (change) lines.push(`| ${change.status} | \`${cell(label(token))}\` | ${cell(show(change.before))} | ${cell(show(token))} |`);
  }
  for (const token of changes.removedTokens) lines.push(`| removed | \`${cell(label(token))}\` | ${cell(show(token))} | |`);
  for (const [name, change] of changes.components) {
    if (change.added) lines.push(`| added | \`${name}\` | | component |`);
    for (const v of change.variants) {
      const value = `\`${v.prop}="${cell(v.value)}"\``;
      lines.push(`| ${v.status} | \`${name}\` | ${v.status === "removed" ? value : ""} | ${v.status === "added" ? value : ""} |`);
    }
  }
  for (const component of changes.removedComponents) lines.push(`| removed | \`${component.name}\` | component | |`);
  if (previewUrl) lines.push("", `[Open the design system preview](${previewUrl}) (download the artifact, open \`preview.html\`).`);
  return lines.join("\n");
}

/** Renders the project's spec (marked against `base` when given) and writes it. Returns where, and how many changes. */
export async function writePreview(root: string, options: { out?: string; base?: string } = {}): Promise<{ file: string; changes?: number }> {
  const config = await loadConfig(root);
  const spec = await loadSpec(root, config);
  const before = options.base ? await specAt(root, config, options.base) : undefined;
  const file = path.resolve(root, options.out ?? path.join(config.specDir, "preview.html"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderPreview(spec, { title: await projectTitle(root), before }));
  if (!options.out) await ignoreInSpecDir(root, config.specDir, "preview.html");
  return { file, changes: before ? previewChanges(before, spec).count : undefined };
}

export async function projectTitle(root: string): Promise<string> {
  try {
    const name = (JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name?: string }).name;
    if (name) return `${name} design system`;
  } catch {
    // no package.json
  }
  return `${path.basename(root)} design system`;
}

/** The preview is generated: keep it out of git next to the spec. */
async function ignoreInSpecDir(root: string, specDir: string, entry: string): Promise<void> {
  const file = path.join(root, specDir, ".gitignore");
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  if (current.split(/\r?\n/).includes(entry)) return;
  await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
}
