# Design rules

<!--
  Plain-language rules for people and AI agents. Keep each rule short and checkable.
  Deterministic rules (colors, variants, imports) are enforced by `designspec check`.
-->

- Use semantic color tokens (`bg-primary`, `text-muted-foreground`), never raw hex values or Tailwind palette colors.
- Use spacing and sizing from the scale. Arbitrary values need a reason.
- Use components from the UI directory instead of native elements or headless primitives.
- One primary action per view.
