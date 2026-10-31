# designspec

## 0.1.0

### Minor Changes

- 207a016: First npm release.
  
  - Config is validated against a schema (`designspec.config.json` gets a `$schema` for editor completion); unknown rules and options are errors.
  - Stylesheets outside the token sources are checked for hardcoded colors.
  - New rule `no-unknown-token`: `var(--x)` references that nothing in the project defines.
  - MUI `sx` props are checked like style props.
  - In a monorepo, `init` writes skills and `.mcp.json` to the git root (`designspec-<app>`), and skills find the nearest config.
  - MCP prompts `check_changes` and `propose`.
  - `fix` replaces on-scale React Native style numbers with tokens (`padding: 16` → `spacing.md`) and imports the token group.
  - The GitHub Action keeps one PR comment per app up to date with every problem; `check --format markdown`.
  - Proposal paths use `/` on Windows; tested on Linux and Windows, Node 20 and 22.
  - `init --force` refreshes detected settings and keeps your rules, zones and other settings.
  - Documentation: `docs/` (CLI, configuration, rules, GitHub Action, AI agents) and `CONTRIBUTING.md`.
  - AI review: the design context lists each component's exports, so suggestions only name parts that exist; usage reports cache writes.
  - Non-color `@theme` aliases (`--radius-lg: var(--radius)`) are extracted as tokens. Run `designspec sync` after upgrading.
  - `require-proposal` watches the token sources including the files they `@import`, and no longer asks for a proposal when only the spec changes.
  - Figma: `designspec figma export-script | diff | push-script`, MCP tools and the `designspec-figma` skill compare Figma variables with the spec per mode and push code values back, as aliases where the code uses them.
  - Never passes silently: `check`, `init` and the PR comment list what couldn't be checked (styled-components/Emotion, tailwind-variants, Chakra, Mantine, Panda, vanilla-extract, StyleX, Vue, Svelte, Astro, Sass, Less). New `designspec doctor` shows coverage per rule.
  - Token files: W3C DTCG (incl. 2025 color and dimension objects) and Tokens Studio JSON as the token source (`tokenFiles`), with modes per file; `init` finds them.
  - Fixes for tokens without a Tailwind utility suggest `text-[var(--token)]` instead of a class that doesn't exist.
  - styled-components and Emotion: CSS in tagged templates, object styles and the `css` prop is checked (hardcoded colors, unknown tokens), reported at the right line.
  - tailwind-variants: `tv()` variants, defaults and controlled classes are read like `cva()`, and `tv()` strings are checked as class lists.
  - Design system packages: a workspace UI package (`packages/ui` imported as `@acme/ui`) is detected, barrel imports resolve, and `uiPackages` reads design systems from npm through their type declarations.
  - SCSS and Less: files are checked, `$` / `@` variables are tokens (fixes suggest `$brand`), `@use`/`@import` partials are followed; color functions over variables (`rgba($black, .5)`) aren't reported.
  - `init` no longer writes `include` / `exclude` unless changed, so new defaults (like checking stylesheets) reach existing projects.
  - Chakra UI, Mantine and MUI: theme tokens are read from `createSystem` / `createTheme` (semantic tokens, `_dark`, color arrays), style props with hardcoded or default-palette colors are reported, and fixes name theme colors (`bg="brand.500"`).
  - Vue and Svelte: templates (classes, bindings, components, inline styles), scripts and `<style lang="scss">` blocks are checked with the same rules, at file positions.
  - AI tools beyond Claude Code: Cursor rules and MCP, Copilot instructions and VS Code MCP, Gemini CLI and Windsurf rules (`init --tools`, new `designspec agents`); tools the repo already uses are set up automatically.
  - Design system change workflow: `explore` finds repeated overrides and values (missing variants and tokens), proposals declare their expected spec changes in front matter, `apply` syncs, migrates and verifies, and `verify` checks the code made exactly those changes. Also as MCP tools and an `apply` prompt.
  - `designspec preview`: one HTML page of the design system, every token drawn in each mode and every component with its variants. With `--diff`, changes are marked; the GitHub Action attaches it to PRs and lists changed tokens (with color swatches), components and variants in the PR comment.
  - Bare numbers such as font weights (`400`) and radii (`9999`) are no longer read as colors; `sync` updates tokens whose type changed.
  - Design system adoption score in `explore` and `doctor`: components from the design system vs native elements it replaces, token colors vs hardcoded and palette ones.
  - The `designspec` agent skill (`skills/designspec`): how to set up and use designspec, installable as a Claude Code plugin or with `npx skills add`.
