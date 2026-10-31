# Rules

Every rule takes the `ignore` option (globs of files it skips) besides the options listed here. Rules
marked *not in UI dir* don't run inside `uiDir`, the design system's own components.

## `no-hardcoded-color` · error · not in UI dir

Colors that aren't tokens:

- arbitrary class values: `bg-[#e5484d]`, `text-[rgb(0_0_0)]`, `shadow-[0_0_0_1px_#000]`
- style objects (`style`, `*Style`, MUI `sx`, `StyleSheet.create`): `{ color: "#333" }`, `{ border: "1px solid #ccc" }`
- color props: `fill="#000"`, `stroke`, `color`, `tintColor`, `placeholderTextColor`…
- color-named keys anywhere: `{ label: "Sales", color: "#10b981" }`
- CSS files outside the token sources, and CSS in styled-components / Emotion templates (`styled.div`…``,
  `css`…``, `createGlobalStyle`), object styles (`styled.div({ … })`) and the Emotion `css` prop

The suggestion is the visually closest token (CIEDE2000), preferring foreground tokens for `text-*` and
surface tokens for `bg-*`. Translucent colors aren't matched to opaque tokens.

## `no-palette-color` · error · not in UI dir · Tailwind

Tailwind's built-in palette (`bg-red-500`, `text-zinc-400/80`), with the closest token as a fix.

| Option | |
| --- | --- |
| `blackWhite` | Also report `bg-white` / `text-black`. With an opacity modifier (`bg-black/50`) they stay allowed |

## `no-arbitrary-value` · warn · not in UI dir · Tailwind

Arbitrary values for utilities that have a scale: spacing (`p-[13px]`, `gap-[6px]`), radius, font size,
line height, letter spacing, font weight, shadows, borders, rings, opacity, z-index. Layout sizes
(`w-[372px]`, `max-w-[720px]`, `grid-cols-[...]`) are one-off by nature and allowed. `var(--token)` values
are always allowed.

| Option | |
| --- | --- |
| `allow` | Utility prefixes to allow, e.g. `["tracking"]` |
| `prefixes` | Check exactly these prefixes instead, e.g. `["p", "m", "w", "h"]` |

## `no-raw-style-value` · warn · not in UI dir · React Native

Raw numbers for spacing (`padding*`, `margin*`, `gap`) and radius (`border*Radius`) when the theme has a
scale. On-scale values get the token (`padding: 16` → `spacing.md`, which `fix` applies); off-scale values
list the scale.

| Option | Default | |
| --- | --- | --- |
| `allow` | `[0]` | Numbers that are fine |
| `scales` | `{ "spacing": ["spacing", "space"], "radius": ["radius", "radii"] }` | Theme export names holding each scale |

## `prefer-ds-component` · error · not in UI dir

Native elements or platform primitives a design system component `replaces`. `init` fills `replaces` by
file name; edit it in the component's spec.

| Component file | Replaces (web) | Replaces (React Native) |
| --- | --- | --- |
| `button` | `button` | `react-native:Button` |
| `input` | `input` (text-like types) | `react-native:TextInput` |
| `checkbox`, `radio-group`, `slider` | `input[type=checkbox]`, `input[type=radio]`, `input[type=range]` | |
| `textarea`, `select`, `label`, `table`, `separator`, `progress`, `dialog` | the matching element (`hr` for separator) | |
| `touchable`, `pressable` | | `TouchableOpacity`, `TouchableHighlight`, `TouchableWithoutFeedback`, `Pressable` |
| `text`, `switch`, `spinner` | | `Text`, `Switch`, `ActivityIndicator` |

`module:Name` entries match imports: `react-native:Text` is `import { Text } from "react-native"`.

## `no-unknown-variant` · error

Variant values the component doesn't define: `<Button variant="ghost2">`, `buttonVariants({ size: "xl" })`.

## `no-variant-override` · error · not in UI dir

Classes overriding what a variant controls. `controls` in the component spec lists the height, padding and
radius each variant prop sets; `<Button className="h-12">` should pick a `size` instead. `fix` rewrites
overrides that exactly match a variant.

| Option | |
| --- | --- |
| `allow` | Exact classes that may override, e.g. `["rounded-none"]` for a button fused into an input group |

## `no-unknown-token` · warn

`var(--x)` references nothing in the project defines: in CSS, arbitrary classes (`bg-[var(--x)]`,
`bg-(--x)`) and style objects. Variables defined anywhere in the project count, including `[--x:2rem]`
classes and inline `style={{ "--x": … }}`. Tailwind's theme variables and library variables (`--tw-*`,
`--radix-*`, Base UI's runtime variables) are known.

| Option | |
| --- | --- |
| `allow` | Variable prefixes defined outside the project, e.g. `["--swiper-"]` |

## `restricted-import` · error

Imports of modules outside the files allowed to use them: headless primitives outside `uiDir` (`base-ui`,
`radix` presets) and every entry of `restrictedImports` in the config.

## `zone-tokens` · error

Tokens a [zone](configuration.md#zones) denies, or doesn't allow, in its files.

## `spec-drift` · error

The spec disagrees with code: a token was added, changed or removed, a component's exports or variants
changed, or a component was added or deleted. Run `designspec sync`.

## `require-proposal` · error · `--diff` only

A pull request changes the UI directory, the token sources or the spec without a proposal in
`design/changes/` (or one being archived). Reported once per pull request. Not reported in the pull request
that adopts designspec.
