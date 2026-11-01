# Design system spec

This folder is the source of truth for the design system. It is read by people, by AI coding
agents and by `designspec check` in CI.

| Path | What it holds | Edited by |
| --- | --- | --- |
| `tokens.json` | Design tokens (W3C DTCG format), extracted from CSS | `designspec sync` |
| `components/*.md` | Component contracts: exports, variants, the native elements they replace, and usage docs | frontmatter: `designspec sync` (except `replaces`); body: you |
| `rules.md` | Design rules in plain language | you |
| `changes/` | Open proposals to change the design system | you, via `designspec propose` |
| `archive/` | Accepted proposals | `designspec archive` |
| `baseline.json` | Violations that existed when designspec was adopted; they don't fail checks | `designspec check --update-baseline` |

## Changing the design system

1. `npx designspec-kit propose <name>` and fill in `design/changes/<name>/proposal.md`.
2. Change the code (tokens in CSS, components in the UI directory).
3. `npx designspec-kit sync` to update this spec from code.
4. Open a PR. Once merged, run `npx designspec-kit archive <name>`.
