# GitHub Action

```yaml
name: Design system
on: pull_request
permissions:
  contents: read
  pull-requests: write # for the PR comment
jobs:
  designspec:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # designspec diffs against the PR base
      - uses: Eronred/designspec@v0
```

The action runs on your runner; nothing is sent anywhere unless you turn on the AI review. On a pull
request it reports only problems on lines the PR adds, so existing code doesn't block anyone. It reports
them three ways:

- **Annotations** on the PR diff. GitHub shows at most 10 errors and 10 warnings per step.
- **The job summary**, with every problem.
- **One PR comment** per project, updated on every push and marked ✅ once everything is fixed. No comment is
  opened when there is nothing to report.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `working-directory` | `.` | Folder with `designspec.config.json` |
| `base` | the PR base commit | Ref to diff against. Empty outside pull requests: the whole project is checked |
| `fail-on` | `error` | `error`, `warn` or `never` |
| `comment` | `true` | Keep the PR comment up to date (needs `pull-requests: write`; skipped without it) |
| `github-token` | `github.token` | Token for the comment |
| `preview` | `true` | On pull requests, upload the [design system preview](cli.md#preview) with the PR's changes marked as an artifact, and add the changed tokens, components and variants (with color swatches) to the PR comment |
| `ai-review` | `false` | Also run the [AI review](ai-agents.md#ai-review). Suggestions only, never fails the check |
| `anthropic-api-key` | | API key for the AI review, e.g. `${{ secrets.ANTHROPIC_API_KEY }}` |

`v0` follows the latest 0.x release. Pin `v0.1.0` for a fixed version.

## Monorepos

One job per app, each with its own `designspec.config.json`:

```yaml
on:
  pull_request:
    paths: ["apps/web/**", "apps/mobile/**"]
jobs:
  designspec:
    strategy:
      fail-fast: false
      matrix:
        app: [web, mobile]
    name: designspec (${{ matrix.app }})
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Eronred/designspec@v0
        with:
          working-directory: apps/${{ matrix.app }}
```

Annotations and the comment use repository paths (`apps/web/…`), and each app gets its own comment.

## AI review

```yaml
      - uses: Eronred/designspec@v0
        with:
          ai-review: true
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

It runs even when the check fails, and never fails the job: without a key, on API errors or for very large
diffs it reports why it skipped.

## Blocking merges

Make the check required in branch protection or a ruleset. On GitHub Free, private repositories don't have
branch protection; there the check is red but doesn't stop the merge button.

## Using the action from a private fork

GitHub only lets other repositories use actions from a private repository when the repository allows it:
**Settings → Actions → General → Access**.
