# Configuration

`designspec init` writes `designspec.config.json` from what it detects. It is validated on every run:
unknown keys, rules and rule options are errors. The `$schema` line gives editors completion and inline
docs.

```json
{
  "$schema": "https://unpkg.com/designspec-cli/schema.json",
  "presets": ["react", "tailwind-v4", "shadcn", "base-ui"],
  "uiDir": "src/components/ui",
  "uiImport": "@/components/ui",
  "cssFiles": ["src/app/globals.css"],
  "rules": {
    "no-arbitrary-value": ["warn", { "allow": ["tracking"] }],
    "no-hardcoded-color": ["error", { "ignore": ["src/components/logos/**"] }]
  }
}
```

## Keys

| Key | Default | |
| --- | --- | --- |
| `presets` | `["react"]` | What the project uses; turns rules and extractors on. See [Presets](#presets) |
| `uiDir` | `src/components/ui` | The design system's components. Contracts are extracted from here; most rules don't run inside it |
| `uiImport` | `@/components/ui` | How the rest of the code imports `uiDir`: a path alias, or a workspace package name (`@acme/ui`) |
| `uiPackages` | `[]` | Design system packages installed from npm, read from their type declarations. See [Design system packages](#design-system-packages) |
| `cssFiles` | `[]` | CSS, SCSS or Less files that define tokens (custom properties, `$variables`, `@variables`). Local `@import` / `@use` / `@forward` are followed, including Sass partials; these files aren't checked themselves |
| `themeFiles` | `[]` | JS/TS modules that export tokens (React Native): `export const spacing = { md: 16 }` |
| `tokenFiles` | `[]` | W3C DTCG or Tokens Studio JSON files. See [Token files](#token-files) |
| `tailwindConfig` | | Tailwind v3 config, read statically to map utilities to CSS variables |
| `specDir` | `design` | Folder holding the spec |
| `include` | `["**/*.{js,jsx,ts,tsx,css,scss,less,vue,svelte}"]` | Files to check. `init` only writes it when you change it, so new defaults reach you |
| `exclude` | `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`, `*.d.ts` | Files to skip |
| `classFunctions` | `cn`, `clsx`, `classnames`, `cva`, `twMerge`, `twJoin` | Functions whose string arguments are class lists |
| `restrictedImports` | `[]` | Modules only some files may import. See below |
| `zones` | `[]` | Parts of the app with their own token set. See below |
| `eslintAliases` | `{}` | Treat existing `eslint-disable` comments as designspec ignores. See below |
| `figma` | | `fileKey`, `modes` (Figma mode → code mode) and `ignoreCollections`. See [figma.md](figma.md) |
| `rules` | `{}` | Rule levels and options ([rules](rules.md)) |

## Token files

When tokens are kept in JSON (Style Dictionary, Tokens Studio, the W3C format) and CSS is generated from
them, list the JSON files; `init` finds `*.tokens.json`, `tokens/**/*.json` and `design-tokens.json`.

```json
{
  "tokenFiles": [
    "tokens/base.tokens.json",
    { "path": "tokens/dark.tokens.json", "mode": "dark" },
    { "path": "tokens/studio.json", "set": "global" }
  ]
}
```

- W3C DTCG: `$value`, `$type` (inherited from groups), `{color.blue.500}` aliases, the 2025 color
  (`{ colorSpace, components }`) and dimension (`{ value, unit }`) objects.
- Tokens Studio: `value` / `type`; `set` picks one set of a single-file export.
- `mode` makes a file the values of a theme mode (as `.dark` would in CSS).
- Each token maps to the CSS variable Style Dictionary generates: `color.bg.primary` → `--color-bg-primary`.
  When the project's CSS defines the same variable, the token file is the source and the CSS only adds the
  Tailwind utility.

## Design system packages

**In the same monorepo.** When the app has no UI folder of its own and depends on a workspace package named
like a design system (`@acme/ui`, `@repo/design-system`), `init` sets `uiDir` to that package's source
(`../../packages/ui/src`) and `uiImport` to its name. Barrel imports (`import { Button } from "@acme/ui"`)
and subpath imports both resolve to the right component.

**From npm.** List the package in `uiPackages`. designspec reads its type declarations (following
`export * from` inside the package): variants come from string-literal union props, including compiled
`VariantProps<typeof buttonVariants>`. A new version of the package changes the spec; `sync` picks it up.
Classes the variants control can't be read from compiled code, so `no-variant-override` doesn't apply to them.

```json
{ "uiPackages": ["@acme/kit"] }
```

## Presets

| Preset | Adds |
| --- | --- |
| `react` | JSX/TSX analysis (React, Next.js, Vite, Remix…). `.vue` and `.svelte` files are checked too: templates (incl. `:prop` / `{expr}` bindings and kebab-case components), scripts and `<style>` blocks |
| `react-native` | Tokens from `themeFiles`, `StyleSheet.create` checks, `no-raw-style-value`, React Native primitives in `replaces` |
| `tailwind-v4` | Class rules; tokens from `:root`, theme selectors (`.dark`, `[data-palette="ocean"]`) and `@theme`, following local `@import`s |
| `tailwind-v3` | The same, with utilities mapped through `theme.colors` / `theme.extend.colors` in `tailwindConfig` |
| `shadcn` | Component contracts from `cva()` and tailwind-variants `tv()` (incl. slots); other components get variants from string-literal union props |
| `base-ui`, `radix` | Headless primitives may only be imported inside `uiDir`; Base UI runtime variables count as known tokens |
| `chakra`, `mantine`, `mui` | Theme tokens from `createSystem` / `createTheme` / `extendTheme` (incl. Chakra semantic tokens with `_dark` and Mantine color arrays); style props (`bg`, `color`, `*Color`, Mantine `c`) are checked, fixes name theme colors (`brand.500`, `primary.main`), and Chakra / Mantine default palette colors (`red.500`, `blue.6`) count as palette colors |

## Rules

Each rule is `"error"`, `"warn"`, `"off"`, or `[level, options]`. Every rule takes `ignore`, a list of
globs it skips:

```json
{
  "rules": {
    "prefer-ds-component": ["error", { "ignore": ["src/components/landing/**"] }],
    "no-variant-override": ["error", { "allow": ["rounded-none"] }],
    "no-palette-color": ["error", { "blackWhite": true }]
  }
}
```

The options of each rule are in [rules.md](rules.md).

## Restricted imports

```json
{
  "restrictedImports": [
    { "from": ["lucide-react"], "allowIn": ["src/components/icons/**"], "message": "Use @/components/icons." }
  ]
}
```

`from` takes module globs (`@radix-ui/**`). The `base-ui` and `radix` presets add a restriction like this
for their packages, allowed only in `uiDir`.

## Zones

Parts of an app can have their own token set, for example marketing pages built on `landing-*` tokens:

```json
{
  "zones": [
    {
      "name": "product",
      "files": ["app/dashboard/**", "components/**"],
      "ignore": ["components/landing/**"],
      "denyTokens": ["landing-*"],
      "message": "landing-* tokens are for marketing pages."
    },
    { "name": "marketing", "files": ["components/landing/**"], "allowTokens": ["landing-*", "radius-landing-*"] }
  ]
}
```

`denyTokens` and `allowTokens` match token names (as in `design/tokens.json`). The `zone-tokens` rule
reports violations; the MCP `find_tokens` tool leaves out tokens a file's zone doesn't allow.

## ESLint aliases

Teams moving from custom design-token ESLint rules can keep their existing `eslint-disable` comments, and
the reasons written next to them:

```json
{
  "eslintAliases": {
    "acme/design-tokens": ["no-palette-color", "no-hardcoded-color"],
    "acme/legacy": ["*"]
  }
}
```

`eslint-disable-next-line`, `eslint-disable-line` and a file-level `/* eslint-disable … */` then also
silence the mapped designspec rules. A bare `eslint-disable` without rule names silences every rule, as
in ESLint.

## Monorepos

Each app has its own `designspec.config.json` and `design/`. Run commands from the app folder or with
`-C`: `designspec -C apps/web check`. See [github-action.md](github-action.md) for CI.
