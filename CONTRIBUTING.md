# Contributing

```bash
npm install
npm test            # vitest
npm run typecheck
npm run build       # dist/cli.js
```

Try the CLI on a fixture:

```bash
cp -R test/fixtures/next-shadcn /tmp/demo
node dist/cli.js -C /tmp/demo init
node dist/cli.js -C /tmp/demo check
```

## Layout

| Path | |
| --- | --- |
| `src/cli.ts` | Commands |
| `src/detect.ts` | Stack detection for `init` |
| `src/extract/` | Tokens (CSS, Tailwind v3 config, JS themes) and component contracts |
| `src/spec.ts` | Reading and writing `design/` |
| `src/check/` | The check runner, CSS checks and `rules/` (one file per rule) |
| `src/fix.ts` | Automatic rewrites |
| `src/mcp.ts`, `src/review.ts` | MCP server, AI review |
| `src/config.ts` | Config schema; `schema.json` is generated from it (`npm run schema`) |
| `action.yml` | The GitHub Action |
| `test/fixtures/` | Next.js + shadcn, Vite + Tailwind v3, Expo projects |
| `test/action-fixture/` | Project the `Action e2e` workflow runs the action against |
| `skills/designspec/` | The skill that teaches agents designspec; `references/` are copies of `docs/` (`npm run skills` after editing docs, a test checks it) |
| `.claude-plugin/` | Makes the repository a Claude Code plugin marketplace for that skill |

## Adding a rule

1. Add `src/check/rules/<id>.ts` exporting a `FileRule` and register it in `src/check/rules/index.ts`.
2. Add it, with its options, to `RulesSchema` in `src/config.ts` and run `npm run schema`.
3. Report a fix the user can act on in the suggestion: the token, component or variant to use.
4. Test it against a fixture, and on a real project if you can: false positives are the main risk.
5. Document it in `docs/rules.md`.

## Releases

Releases use [Changesets](https://github.com/changesets/changesets). Pull requests that change the package
include a changeset:

```bash
npx changeset   # pick patch / minor / major and describe the change for the changelog
```

Merging to `main` opens a "Release: version packages" pull request. Merging that one publishes to npm,
creates the GitHub release and moves the `v0` action tag.

## Website

`site/index.html` is the project page, a single static file. `.github/workflows/pages.yml` deploys it to GitHub Pages on pushes to `main` that touch `site/`, once the repository variable `PAGES_ENABLED` is `true` (and Pages is set to deploy from GitHub Actions). `site/og.png` (the README image and social preview) is rendered from `site/og.html`; the command is at the top of that file.
