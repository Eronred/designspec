# CLI

Every command runs in the current directory; `-C <dir>` (before the command) runs it in another project:
`designspec -C apps/web check`.

## `init`

Detects the stack and sets up designspec:

- writes `designspec.config.json` ([configuration](configuration.md)),
- extracts `design/tokens.json` and `design/components/*.md`, adds `design/rules.md` and `design/README.md`,
- sets up AI agents: an `AGENTS.md` section, the `designspec-ui` and `designspec-propose` skills and an MCP
  server in `.mcp.json` ([AI agents](ai-agents.md)),
- records the current violations in `design/baseline.json`.

| Option | |
| --- | --- |
| `-f, --force` | Re-initialize when a config exists: detected fields (`presets`, `uiDir`, `cssFiles`…) are refreshed; your rules, zones and other settings and the spec's hand-written parts are kept |
| `--no-agents` | Skip AI agent setup |
| `--tools <tools>` | AI tools to set up: `claude`, `cursor`, `copilot`, `gemini`, `windsurf`. Default: Claude Code plus the tools the repo already uses |
| `--no-baseline` | Don't record existing violations |

## `check [paths...]`

Runs the [rules](rules.md) on the project, or on the given files and folders.

| Option | Default | |
| --- | --- | --- |
| `--diff <base>` | | Only report problems on lines added since the merge base with `<base>` (what a PR shows). Enables `require-proposal` |
| `--format <format>` | `pretty` | `pretty`, `json`, `github` (workflow annotations + job summary), `markdown` (for PR comments) |
| `--fail-on <level>` | `error` | Exit with code 1 on `error`, `warn` or `never` |
| `--no-baseline` | | Also report violations recorded in the baseline |
| `--update-baseline` | | Record every current violation as the new baseline |

Exit codes: `0` passed, `1` problems at the `--fail-on` level (or an invalid command-line option), `2` a missing or invalid config.

## `fix [paths...]`

Rewrites code only where the result looks exactly the same:

- **Variant overrides.** `<Panel padding="none" className="px-3 py-2">` → `<Panel padding="compact">` when the
  `compact` option sets exactly those classes, the override fully replaces what the current option sets, and
  the new option brings no other styles along.
- **Token colors.** `text-[#1850ff]` → `text-brand` when the token has exactly that value.
- **React Native.** `padding: 16` → `spacing.md` (and `-8` → `-spacing.sm`), importing the token group from
  the theme when the file doesn't have it, in the file's quote and semicolon style.

| Option | |
| --- | --- |
| `--dry-run` | Show what would change |
| `--colors` | Also use color tokens that have a dark mode. The color then follows the theme, which changes how dark mode looks |

## `agents`

Sets up or updates AI agent instructions and MCP config (see [AI agents](ai-agents.md)) without re-running
`init`. `--tools` as for `init`.

## `doctor`

Shows what designspec checks in this project and what it doesn't: the stack, the spec, every rule (active,
inactive because a preset is missing, or idle because the spec gives it nothing to check), the AI agent setup,
and the code it can't check (styled-components, `.vue` files…). `--json` for tools.

`check` and `init` also list what they couldn't check, so a clean result is never mistaken for full coverage.
On a pull request, only the files the change touches are listed.

## `sync`

Updates `design/tokens.json` and the component frontmatter from code. Component docs (the Markdown body)
and `replaces` are kept. Prints what changed, and reminds you when no proposal is open.

## `explore`

Starts with the **design system adoption** score, then maps where code works around it.

```
Design system adoption: 97%
  Components: 97% (9534 from the design system, 317 bypassing it)
  Colors: 98% (7839 through tokens, 174 bypassing it)
```

Components counts design system components used against native elements and primitives used where a
component replaces them. Colors counts token colors (`bg-primary`, `var(--primary)`, `colors.label`,
`bg="brand.500"`) against hardcoded and palette colors. Baselined problems count; spacing and typography
aren't measured yet. `doctor` shows the same score.

Then it lists problems per rule (baselined ones included), hotspot files, className overrides repeated on the same component (a missing variant) and hardcoded colors or
arbitrary values repeated across files (a missing token). `--json` for tools.

## `preview`

Writes one HTML page of the design system to `design/preview.html` (git-ignored): every color, type,
spacing, radius, shadow and motion token drawn with its real value, with a switch for each mode (`dark`,
`palette=ocean`…), and every component with its import, variants (defaults marked) and the elements it
replaces. A filter box narrows tokens and components. Components are listed, not rendered.

| Option | |
| --- | --- |
| `-o, --out <file>` | Write somewhere else |
| `--diff <base>` | Mark tokens, components and variant values added, changed or removed since `<base>` and list them in a Changes section |
| `--format markdown` | With `--diff`: print the changes as a Markdown table instead (the GitHub Action's PR comment uses it). Prints nothing when nothing changed |
| `--url <url>` | With `--format markdown`: link the published page |
| `--open` | Open the page in the browser |

## `apply <name>` · `verify <name>`

- `apply`, after the code change: `sync`, then `fix` (migrates overrides the new variant replaces), ticks the
  proposal's own tasks and runs `verify`.
- `verify` compares the spec before the change (at `--diff <base>`, default `origin/main` or `main`) with the
  code: every change declared in the proposal's front matter must be in code, nothing else in the design system
  may change, and all tasks must be done. Exits with 1 otherwise; `--json` for tools.

## `propose <name>` · `archive <name>` · `list`

- `propose` creates `design/changes/<name>/proposal.md` (with front matter for the expected changes) and
  `tasks.md`. The name is kebab-case.
- `archive` moves an accepted proposal to `design/archive/<date>-<name>/`. It refuses when the spec is out of
  date with code.
- `list` shows open proposals and their task progress.

## `mcp`

Runs the MCP server over stdio. See [AI agents](ai-agents.md).

## `review --diff <base>`

Optional AI review of the changes since `<base>` against `design/rules.md` and the spec. Needs
`ANTHROPIC_API_KEY`. Reports suggestions; never fails.

| Option | Default | |
| --- | --- | --- |
| `--format <format>` | `pretty` | `pretty`, `json`, `github` |
| `--model <model>` | `claude-opus-5-5` | Claude model |
| `--effort <effort>` | `medium` | `low`, `medium` or `high` |

## `figma export-script` · `figma diff <exports...>` · `figma push-script <exports...>`

Compare Figma variables with the spec and write code values into Figma. See [Figma](figma.md).

| Command | Option | |
| --- | --- | --- |
| `export-script` | `--collections <names>` | Only these collections, for exports over `use_figma`'s 48 KB limit |
| `diff` | `--format <format>` | `pretty`, `json`, `markdown` |
| `push-script` | `--tokens <names>` | Only these tokens, e.g. `--scrollbar-thumb,--ring` |

## Ignoring a line

```tsx
// designspec-ignore-next-line no-hardcoded-color: partner brand color
<span className="bg-[#ff6600]">Partner</span>

<span className="bg-[#ff6600]" /> {/* designspec-ignore-line */}
```

- `designspec-ignore-next-line` and `designspec-ignore-line` take an optional comma-separated list of rules;
  without one they ignore every rule on that line. Write the reason after a colon.
- `designspec-ignore-file` in the first lines of a file skips the whole file.
- In CSS, use `/* designspec-ignore-next-line */`.
- Existing `eslint-disable` comments can count too: see `eslintAliases` in [configuration](configuration.md).
