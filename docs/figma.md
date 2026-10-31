# Figma

designspec compares Figma variables with the spec and writes code values back into Figma. It works through
an AI agent that has the [Figma MCP server](https://help.figma.com/hc/en-us/articles/32132100833559): designspec
produces Plugin API scripts, the agent runs them with the server's `use_figma` tool, and designspec reads the
results. The Plugin API reads and writes variables on every Figma plan, unlike the REST variables API, which
needs Enterprise.

Code is the source of truth for values. When the two disagree, either Figma follows the code (push), or the
code is out of date and the change goes through a [proposal](../README.md#changing-the-design-system).

## In an agent

`init` installs the `designspec-figma` skill. Ask the agent to "compare Figma with the code" and give it the
file (or set `figma.fileKey` in the config). It runs:

1. **`figma_export_script`** → runs the script with `use_figma`. The script only reads.
2. **`figma_diff`** with the result → differences per token and mode.
3. **`figma_push_script`** for the tokens you agree Figma should follow → shows the changes → runs it with
   `use_figma` once you say so.

## From the command line

```bash
designspec figma export-script > export.js        # run export.js with use_figma; save its result as export.json
designspec figma diff export.json                  # --format pretty | json | markdown
designspec figma push-script export.json --tokens --scrollbar-thumb,--ring
```

```
  --sidebar-primary   Midnight Dark   figma #e6e6e6   code oklch(0.42 0.08 255) (#2d4e78)
Only in code: --scrollbar-track, --landing-feature-stone
⚠ 412/415 values match, 10 not comparable (derived or relative values), 1 alternate values (landing/topbar-lg)
```

## How variables are matched

- **By code syntax.** A Figma variable whose WEB code syntax is `var(--background)` is compared with the
  `--background` token. Variables without WEB code syntax aren't exported, so imported UI kits and unrelated
  collections stay out on their own.
- **Modes by name.** "Light" or "Value" → the default values, "Dark" → `.dark`, "Ocean Dark" →
  `.dark[data-palette="ocean"]`. Values missing in a mode follow the CSS cascade: the most specific selector
  that defines them wins. Override with `figma.modes` when names don't line up:
  `{ "figma": { "modes": { "Night": "dark" } } }`.
- **Colors as Figma stores them.** Code colors are clipped to 8-bit sRGB before comparing, so a wide-gamut
  `oklch()` matches the hex Figma shows. `var(--border)` is resolved in the same mode.
- **Lengths in pixels.** `rem`, `calc(var(--radius) - 4px)` and `calc(var(--spacing) * 4)` are computed;
  Tailwind's default theme (`--text-xs`, `--spacing`…) is known.
- **Not comparable:** derived code syntax (`color-mix(...)`) and values that depend on the viewport or font size
  (`clamp()`, `em`, unitless line heights). They are counted, not reported as differences.
- **Alternates.** When several Figma variables share a code syntax (a desktop and a mobile size), one matching
  is enough; the others are listed as alternates.

## How pushes keep Figma's structure

For each difference, the push script writes, in order of preference:

1. an alias to the matching variable when the code uses one (`--scrollbar-thumb: var(--border)` → alias to
   `border`), so the value keeps following it in every mode;
2. an alias to a primitive with the same value (`palette/midnight/primary`);
3. the raw value.

## Size limit

`use_figma` returns at most 48 KB. The export is compact (a design system with eight color modes and ~200
variables is about 30 KB). For larger ones, export a few collections at a time
(`export-script --collections "Color,Radius"`) and pass all results to `diff`.

The export travels through the agent's context to `figma_diff`, so very large design systems cost tokens
on every comparison.
