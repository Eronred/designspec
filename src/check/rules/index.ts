import type { FileRule } from "../types.js";
import { noArbitraryValue } from "./no-arbitrary-value.js";
import { noHardcodedColor } from "./no-hardcoded-color.js";
import { noPaletteColor } from "./no-palette-color.js";
import { noRawStyleValue } from "./no-raw-style-value.js";
import { noUnknownToken } from "./no-unknown-token.js";
import { noUnknownVariant } from "./no-unknown-variant.js";
import { noVariantOverride } from "./no-variant-override.js";
import { preferDsComponent } from "./prefer-ds-component.js";
import { restrictedImport } from "./restricted-import.js";
import { zoneTokens } from "./zone-tokens.js";

export const FILE_RULES: FileRule[] = [
  noHardcodedColor,
  noPaletteColor,
  noArbitraryValue,
  noRawStyleValue,
  preferDsComponent,
  noUnknownVariant,
  noVariantOverride,
  noUnknownToken,
  restrictedImport,
  zoneTokens,
];

/** Rules that look at the project as a whole rather than one file. */
export const PROJECT_RULES = {
  "spec-drift": { description: "The spec must match the tokens and components defined in code.", defaultLevel: "error" },
  "require-proposal": { description: "Changes to the design system's code (UI directory, token sources) need a proposal in the same PR.", defaultLevel: "error" },
} as const;
