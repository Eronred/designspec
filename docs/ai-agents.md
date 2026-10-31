# AI agents

`designspec init` sets up AI coding agents to use the design system: instructions, and the designspec MCP
server. In a monorepo (the project is a subfolder of a git repository), tool files go to the git root, where
agents are usually started, and `AGENTS.md` stays in the project.

It sets up Claude Code and the tools the repository already uses (a `.cursor/`, `.vscode/`, `.gemini/` or
`.windsurf/` folder). Choose others with `--tools`, or later with `designspec agents`:

```bash
npx designspec agents --tools claude,cursor,copilot,gemini,windsurf
```

| Tool | Instructions | MCP server |
| --- | --- | --- |
| Claude Code | `.claude/skills/designspec-{ui,propose,figma}` | `.mcp.json` |
| Cursor | `.cursor/rules/designspec.mdc` (applies to UI files) | `.cursor/mcp.json` |
| GitHub Copilot (VS Code) | `.github/copilot-instructions.md` | `.vscode/mcp.json` |
| Gemini CLI | `GEMINI.md` | `.gemini/settings.json` |
| Windsurf | `.windsurf/rules/designspec.md` (applies to UI files) | |
| Codex, OpenCode and others | `AGENTS.md` | their own MCP settings |

Shared files keep their other content: Markdown files get a section between `<!-- designspec:start -->`
and `<!-- designspec:end -->`, JSON files only a `designspec` entry.

## `AGENTS.md`

A short section, between `<!-- designspec:start -->` and `<!-- designspec:end -->`, telling any agent where
the spec is and what not to do. Re-running `init` replaces only that section.

## Skills

`.claude/skills/designspec-ui`, `designspec-propose` and `designspec-figma`. Claude Code loads them when they
apply and lists them as `/designspec-ui`, `/designspec-propose` and `/designspec-figma`. They find the nearest
`designspec.config.json` above the file being edited, so one copy works for every app in a monorepo.

## The `designspec` skill

The skills above are about building UI in a project. The `designspec` skill in this repository's
[`skills/`](https://github.com/Eronred/designspec/tree/main/skills/designspec) teaches an agent designspec
itself: setting it up, the commands and config, fixing a failing check, changing the design system through a
proposal. It carries these docs as references.

```bash
/plugin install designspec --marketplace Eronred/designspec   # Claude Code (or: /plugin marketplace add Eronred/designspec)
npx skills add Eronred/designspec                             # other agents
```

## MCP server

`init` registers the server in `.mcp.json`:

```json
{ "mcpServers": { "designspec": { "command": "npx", "args": ["-y", "designspec", "mcp"] } } }
```

In a monorepo there is one entry per app, named after its folder:
`"designspec-web": { "command": "npx", "args": ["-y", "designspec", "-C", "apps/web", "mcp"] }`.

### Tools

| Tool | |
| --- | --- |
| `list_components` | Components with their import path, exports, variants and what they replace |
| `get_component` | One component's full contract and usage docs |
| `find_tokens` | Tokens by name or type, or `color: "#e5484d"` for the closest color tokens. `file` leaves out tokens that file's zone doesn't allow. Each result says how to use it (`bg-primary`, `var(--primary)`, `spacing.md`) |
| `check_code` | The CI checks on code that isn't saved yet (`code` + the `file` path it will have) |
| `get_rules` | `design/rules.md` and the active checks |
| `propose_change` | Opens `design/changes/<name>/` with the why, what, alternatives and expected changes |
| `explore_design_system` | Hotspots, repeated overrides and values: what the design system is missing |
| `verify_proposal` | Checks a proposal against the code |
| `preview_design_system` | Writes `design/preview.html` (every token drawn, every component), optionally with changes since a git ref marked |
| `figma_export_script`, `figma_diff`, `figma_push_script` | Compare Figma variables with the spec and push code values ([Figma](figma.md)) |

### Prompts

Clients show these as commands, e.g. `/mcp__designspec__check_changes` in Claude Code:

| Prompt | |
| --- | --- |
| `check_changes` | Check the UI files changed in this session and fix what is found |
| `propose` | Turn a need ("a warning color for quota alerts") into a proposal, after checking nothing existing fits |
| `apply` | Implement a proposal's tasks, then apply and verify it |

The server reads the spec on every call, so `designspec sync` shows up without a restart.

## AI review

`designspec review --diff <base>` covers what deterministic rules can't: the plain-language rules in
`design/rules.md`, new components that duplicate an existing one, a new pattern where the spec has one.

- It sends the diff, with line numbers, and a summary of the spec (rules, components, tokens, zones) to
  Claude (`claude-opus-5-5` by default). The spec part is cached across runs.
- Only findings on added lines are kept, as warnings or notices.
- It never fails. Without `ANTHROPIC_API_KEY`, on API errors, refusals or diffs over 400k characters it
  skips and says why.
- Requests use server-side refusal fallbacks, so a declined request is retried on another model instead of
  failing.

Write `design/rules.md` as short, checkable statements; that is what the review checks against.
