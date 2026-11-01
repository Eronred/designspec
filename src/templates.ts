import type { ComponentSpec } from "./spec.js";

export function componentBody(component: Omit<ComponentSpec, "body">): string {
  const primary = component.exports.find((e) => e === component.name) ?? component.exports[0];
  return `
# ${component.name}

<!-- When should this component be used, and when not? AI agents read this before building UI. -->

## Usage

\`\`\`tsx
import { ${primary} } from "${component.import}"
\`\`\`
`;
}

export const SPEC_README = (specDir: string) => `# Design system spec

This folder is the source of truth for the design system. It is read by people, by AI coding
agents and by \`designspec check\` in CI.

| Path | What it holds | Edited by |
| --- | --- | --- |
| \`tokens.json\` | Design tokens (W3C DTCG format), extracted from CSS | \`designspec sync\` |
| \`components/*.md\` | Component contracts: exports, variants, the native elements they replace, and usage docs | frontmatter: \`designspec sync\` (except \`replaces\`); body: you |
| \`rules.md\` | Design rules in plain language | you |
| \`changes/\` | Open proposals to change the design system | you, via \`designspec propose\` |
| \`archive/\` | Accepted proposals | \`designspec archive\` |
| \`baseline.json\` | Violations that existed when designspec was adopted; they don't fail checks | \`designspec check --update-baseline\` |

## Changing the design system

1. \`npx designspec-kit propose <name>\` and fill in \`${specDir}/changes/<name>/proposal.md\`.
2. Change the code (tokens in CSS, components in the UI directory).
3. \`npx designspec-kit sync\` to update this spec from code.
4. Open a PR. Once merged, run \`npx designspec-kit archive <name>\`.
`;

export const RULES_MD = `# Design rules

<!--
  Plain-language rules for people and AI agents. Keep each rule short and checkable.
  Deterministic rules (colors, variants, imports) are enforced by \`designspec check\`.
-->

- Use semantic color tokens (\`bg-primary\`, \`text-muted-foreground\`), never raw hex values or Tailwind palette colors.
- Use spacing and sizing from the scale. Arbitrary values need a reason.
- Use components from the UI directory instead of native elements or headless primitives.
- One primary action per view.
`;

export interface ProposalSections {
  why?: string;
  what?: string;
  alternatives?: string;
  /** Expected spec changes, as YAML front matter (see `Delta`). */
  delta?: string;
}

const DELTA_TEMPLATE = `# What this proposal changes in the spec; \`designspec verify\` checks the code against it.
tokens:
  add: []      # e.g. [--warning-strong]
  change: []
  remove: []
components:
  add: []      # e.g. [Toast]
  remove: []
variants: {}   # e.g. { Panel.padding: { add: [compact] } }`;

export function proposalTemplate(name: string, sections: ProposalSections = {}): string {
  return `---
${sections.delta?.trim() || DELTA_TEMPLATE}
---

# ${titleCase(name)}

## Why

${sections.why?.trim() || "<!-- What need does the current design system not cover? Link to the screen, ticket or design. -->"}

## What changes

${sections.what?.trim() || "<!-- New or changed tokens, components or variants. -->"}

## Alternatives considered

${sections.alternatives?.trim() || "<!-- Which existing tokens or components were considered, and why they don't fit. -->"}
`;
}

export const TASKS_TEMPLATE = `# Tasks

- [ ] Update tokens / components in code
- [ ] Run \`npx designspec-kit apply <name>\` (sync the spec, migrate overrides, verify)
- [ ] Document usage in the component spec
- [ ] \`npx designspec-kit verify <name>\` passes
`;

export const AGENTS_START = "<!-- designspec:start -->";
export const AGENTS_END = "<!-- designspec:end -->";

export function agentsBlock(specDir: string, uiImport: string): string {
  return `${AGENTS_START}
## Design system

This project's design system is defined in \`${specDir}/\` and enforced in CI by designspec.
Before writing or changing UI:

1. Read \`${specDir}/components/*.md\`, \`${specDir}/tokens.json\` and \`${specDir}/rules.md\`.
2. Reuse components from \`${uiImport}\`; use only the variants listed in their spec.
3. Never hardcode colors, use raw Tailwind palette colors or arbitrary values. Use token utilities like \`bg-primary\`.
4. If the design system doesn't cover what you need, don't invent it: run \`npx designspec-kit propose <name>\`.
5. Run \`npx designspec-kit check\` before you finish.
${AGENTS_END}`;
}

// Skills are written once per repository (at the git root), so they can't name one project's paths.
const FIND_SPEC = `The design system is described by the nearest \`designspec.config.json\` above the file you are editing
(in a monorepo each app has its own). Its spec folder (\`specDir\`, default \`design/\`) sits next to it.`;

export function uiSkill(): string {
  return `---
name: designspec-ui
description: Use whenever building or changing UI (pages, components, styles, className, React Native styles) in a project with a designspec.config.json. Loads the design system spec so new UI uses existing tokens and components instead of hardcoded values.
---

# Building UI with the design system

${FIND_SPEC} CI blocks pull requests that drift from it, so follow it from the start.

## Before writing UI

If a \`designspec\` MCP server is available (\`designspec\` or \`designspec-<app>\`), prefer its tools: \`list_components\`,
\`get_component\`, \`find_tokens\` (pass \`color\` to find the closest token, and \`file\` to respect zones), \`check_code\`
and \`propose_change\`. Otherwise read the files in the spec folder:

1. \`components/*.md\`: each component's \`import\` path, \`exports\`, allowed \`variants\`, what its variants
   \`controls\` and the native elements it \`replaces\`. Read the spec of every component you plan to use.
2. \`tokens.json\` for colors, radii and spacing. On the web use them through utilities (e.g. \`bg-primary\`,
   \`text-muted-foreground\`, \`rounded-lg\`) or \`var(--token)\`. In React Native import them from the theme: each
   token's \`code\` (e.g. \`spacing.md\`, \`colors.label\`) is how to reference it.
3. \`rules.md\`.

## While writing UI

- Import components from their spec's \`import\` path. Don't use native \`<button>\`, \`<input>\` or React Native
  primitives (\`Text\`, \`TouchableOpacity\`) when a component \`replaces\` them.
- Don't import headless primitives (Base UI, Radix) outside the UI directory; use the wrapper.
- No hex/rgb/oklch values, no Tailwind palette colors (\`bg-red-500\`), no arbitrary values (\`p-[13px]\`),
  no raw numbers for spacing or radius in React Native styles (\`padding: 16\` → \`spacing.md\`).
- Only use variant values listed in the component spec, and don't override what a variant controls
  (see \`controls\`) with classes: pick a different variant instead.

## When the design system doesn't cover it

Don't invent a new color, variant or component inline. Use the \`designspec-propose\` skill.
If a one-off exception is truly needed, add \`// designspec-ignore-next-line <rule>: <reason>\` above the line.

## Before finishing

Run \`check_code\` (MCP) or \`npx designspec-kit check <files>\` from the project folder and fix every error.
\`npx designspec-kit fix\` rewrites exact variant overrides safely.
`;
}

export function proposeSkill(): string {
  return `---
name: designspec-propose
description: Use when a UI task needs a token, variant or component that the project's design system (designspec) does not provide, or to find what the design system is missing. Opens, implements and verifies design system change proposals instead of inventing values inline.
---

# Changing the design system

${FIND_SPEC}

1. **Explore.** \`npx designspec-kit explore\` (or the \`explore_design_system\` MCP tool) shows where code works around the
   design system: overrides repeated on a component point at a missing variant, values repeated as hardcoded
   colors or arbitrary values at a missing token. Confirm the need isn't covered (\`components/*.md\`, \`tokens.json\`).
2. **Propose.** \`propose_change\` (MCP) or \`npx designspec-kit propose <kebab-case-name>\` (e.g. \`add-warning-color\`).
   Write why, what changes, and the options you rejected, and fill the front matter with the expected spec changes:
   \`tokens: { add: [--warning] }\`, \`components: { add: [Toast] }\`, \`variants: { Panel.padding: { add: [compact] } }\`.
3. **Apply.** Change the code (token sources, components in the UI directory), then \`npx designspec-kit apply <name>\`:
   it syncs the spec, migrates className overrides to the new variant, ticks its tasks and verifies.
4. **Verify.** \`npx designspec-kit verify <name>\` passes when every declared change is in code, nothing undeclared
   changed and the tasks are done. Fix what it reports.
5. Tell the user the proposal is ready for review in the pull request. After the merge,
   \`npx designspec-kit archive <name>\` moves it to the archive.
`;
}

export function figmaSkill(): string {
  return `---
name: designspec-figma
description: Use when asked to compare, check or sync Figma variables (design tokens) with the code's design system, in a project with a designspec.config.json. Needs the Figma MCP server.
---

# Comparing and syncing Figma with code

${FIND_SPEC} Code is the source of truth for values; Figma follows it. Differences that come from a
design decision go through a proposal (\`designspec-propose\`), not straight into code.

You need the Figma MCP server (\`use_figma\`) and the Figma file: \`figma.fileKey\` in the config, or ask the user.

1. **Export.** Get the script from the designspec MCP tool \`figma_export_script\` (or \`npx designspec-kit figma export-script\`)
   and run it with \`use_figma\` on the file. It only reads. It exports variables that have WEB code syntax.
2. **Compare.** Pass the result to \`figma_diff\` (or save it and run \`npx designspec-kit figma diff <file>\`).
   Show the user the differences per token and mode, plus tokens only in Figma or only in code.
3. **Decide with the user**, token by token: should Figma follow the code, or is the code out of date?
   - Figma follows code: get a script from \`figma_push_script\` with those tokens, show the user the listed
     changes, and run it with \`use_figma\` only after they agree. It writes aliases where the code uses one.
   - Code should change: open a proposal, change the token source, run \`npx designspec-kit sync\`.
4. Run the export and comparison again to confirm.

Never write to Figma without the user's go-ahead for those specific changes.
`;
}

function titleCase(name: string): string {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
