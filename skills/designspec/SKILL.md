---
name: designspec
description: How to use designspec, the tool that keeps AI-written UI on a design system. Use when setting up designspec in a project (init, monorepos, the GitHub Action), configuring designspec.config.json, running or explaining designspec commands (check, fix, sync, explore, preview, propose, apply, verify, doctor, figma), fixing a failing designspec check in CI, or changing the design system through a proposal.
---

# Using designspec

designspec reads a project's design system from code into a spec folder (`design/`: tokens, component
contracts, rules), gives AI agents instructions and an MCP server to follow it, and checks code against it
locally and in a GitHub Action. Code is the source of truth for values; the spec is extracted, not written.

Run it with `npx designspec-kit <command>` from the folder that has (or will have) `designspec.config.json`, or
pass `-C <dir>` before the command: `npx designspec-kit -C apps/web check`. Node 20 or later.

The details are in `references/`: [cli.md](references/cli.md) (every command and option),
[configuration.md](references/configuration.md), [rules.md](references/rules.md),
[github-action.md](references/github-action.md), [ai-agents.md](references/ai-agents.md) and
[figma.md](references/figma.md). Read the one you need before answering from memory.

## Set up a project

1. **Init.** `npx designspec-kit init` in the app folder (in a monorepo, once per app: `apps/web`, `apps/mobile`).
   It detects the stack, writes `designspec.config.json`, extracts `design/`, sets up AI agents and records
   existing violations in `design/baseline.json` so they don't fail checks. Read its output: it says what it
   found and what it couldn't check.
2. **Check what was detected.** Open `designspec.config.json`. If `uiDir`, `uiImport`, `cssFiles`,
   `themeFiles` or `tokenFiles` are wrong or empty, fix them ([configuration.md](references/configuration.md)),
   then `npx designspec-kit init --force` (keeps rules and hand-written settings) or `npx designspec-kit sync`.
3. **Check coverage.** `npx designspec-kit doctor` lists every rule as active, inactive or idle, and the code it
   can't read. A rule that's idle usually means the spec is missing something (no tokens, no `replaces`).
4. **Fill in what code can't say.** Each `design/components/*.md` has a `replaces` list (native elements the
   component stands for) and a Markdown body for usage notes; `design/rules.md` holds plain-language rules.
   These are kept across `sync`.
5. **Add CI.** Add `.github/workflows/design-system.yml` from [github-action.md](references/github-action.md)
   (one matrix job per app in a monorepo). `actions/checkout` needs `fetch-depth: 0`.
6. **Commit** `designspec.config.json`, `design/` and the agent files `init` wrote (`AGENTS.md`, `.claude/`,
   `.mcp.json`…). `design/preview.html` is git-ignored.

Agents: `init` sets up Claude Code plus the tools the repo already uses; add others with
`npx designspec-kit agents --tools claude,cursor,copilot,gemini,windsurf`. Re-run `agents` after upgrading
designspec to refresh the instructions. Those project skills (`designspec-ui`, `designspec-propose`,
`designspec-figma`) are what agents follow when they build UI in that project; this skill is about running
designspec itself.

## Day to day

| Task | Command |
| --- | --- |
| Check the whole project, or some files | `npx designspec-kit check [paths]` |
| Check only what a branch changed, as CI does | `npx designspec-kit check --diff origin/main` |
| Apply the safe fixes (variant overrides → variants, exact token colors, React Native numbers → tokens) | `npx designspec-kit fix` (`--dry-run` first) |
| Update the spec after changing tokens or components | `npx designspec-kit sync` |
| See every token and component on one page | `npx designspec-kit preview --open` (`--diff main` marks changes) |
| Find what the design system is missing | `npx designspec-kit explore` |

A problem that's intentional gets a comment with a reason, not a config change:
`// designspec-ignore-next-line no-hardcoded-color: partner brand color`. Turn a rule off or narrow it in
`rules` only when it's wrong for the whole project ([configuration.md](references/configuration.md#rules)).

## Fix a failing check

Run the same command locally: `npx designspec-kit check --diff origin/main` (from the app folder). Then, by rule:

- **`no-hardcoded-color`, `no-palette-color`**: use the token in the suggestion (`↳ Closest token: …`).
  `fix` applies exact matches. If no token fits, the design system needs one: open a proposal.
- **`no-arbitrary-value`, `no-raw-style-value`**: use the scale value; `fix` rewrites on-scale React Native
  numbers.
- **`prefer-ds-component`**: import the component named in the suggestion instead of the native element.
- **`no-unknown-variant`**: use one of the listed values, or propose the new variant.
- **`no-variant-override`**: pick the variant that sets that size or padding instead of a class. `fix`
  rewrites overrides that exactly match a variant.
- **`no-unknown-token`**: a typo, or a variable defined outside the project (add its prefix to the rule's `allow`).
- **`restricted-import`**: import the wrapper from the UI directory, not the headless library.
- **`zone-tokens`**: the token belongs to another zone (e.g. `landing-*` in product UI); use one this zone allows.
- **`spec-drift`**: code changed tokens or components and the spec wasn't updated. Run `npx designspec-kit sync`
  and commit `design/`.
- **`require-proposal`**: the PR changes the design system (UI directory, token sources or spec) without a
  proposal. Open one (below), or move the design system change to its own PR.

Problems recorded in `design/baseline.json` don't fail checks; `--no-baseline` shows them. Don't run
`--update-baseline` to make a red check green: it hides new problems too. Use it only after a deliberate
cleanup or rule change, and say so.

## Change the design system

New tokens, variants or components go through a proposal, so the PR says why and CI can verify it:

1. `npx designspec-kit explore`: confirm the need (repeated overrides point at a missing variant, repeated
   hardcoded values at a missing token) and that nothing existing fits.
2. `npx designspec-kit propose <kebab-case-name>`: fill in `design/changes/<name>/proposal.md` (why, what,
   rejected options) and its front matter with the expected changes:
   `tokens: { add: [--warning] }`, `components: { add: [Toast] }`, `variants: { Panel.padding: { add: [compact] } }`.
3. Change the code (token sources, components in `uiDir`).
4. `npx designspec-kit apply <name>`: syncs the spec, migrates overrides to the new variant, ticks tasks, verifies.
5. `npx designspec-kit verify <name>` must pass: every declared change is in code and nothing else changed.
6. After the PR merges: `npx designspec-kit archive <name>`.

On the PR, the Action's comment lists changed tokens (with before/after color swatches), components and
variants, and attaches the preview page as the `designspec-preview` artifact.

## Figma

With the Figma MCP server, designspec compares Figma variables with the spec per mode and pushes code values
back. Follow the project's `designspec-figma` skill or [figma.md](references/figma.md). Never write to Figma
without the user agreeing to the specific changes.

## When something looks wrong

- **Nothing is reported where you expected problems**: `npx designspec-kit doctor`. Classes built at runtime
  (`` `bg-${color}-500` ``), Angular/Astro templates, Panda CSS, vanilla-extract and StyleX aren't checked.
- **A token or variant is missing from the spec**: check that its source file is in `cssFiles`, `themeFiles`
  or `tokenFiles`, or that the component is in `uiDir` (or `uiPackages`), then `sync`. Values computed at
  runtime (`isAndroid ? 48 : 44`) are skipped.
- **Wrong token suggested**: suggestions are the visually closest token; prefer the semantic one the
  surrounding code uses.
- **Config errors** (exit code 2): unknown keys, rules or options. The `$schema` line in the config gives
  editor completion.
- **Exit codes**: `0` passed, `1` problems at the `--fail-on` level, `2` missing or invalid config.
