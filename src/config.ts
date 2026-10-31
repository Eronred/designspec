import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const Level = z.enum(["error", "warn", "off"]);
const Globs = z.array(z.string());

/** `"error"` or `["error", { ...options }]`; every rule takes `ignore` globs. */
function rule(options: z.ZodRawShape = {}) {
  const shape = z.object({ ignore: Globs.optional().describe("Files this rule skips"), ...options }).strict();
  return z.union([Level, z.tuple([Level, shape])]).optional();
}

const RulesSchema = z
  .object({
    "no-hardcoded-color": rule(),
    "no-palette-color": rule({ blackWhite: z.boolean().optional().describe("Also report bg-white/text-black without an opacity modifier") }),
    "no-arbitrary-value": rule({
      allow: Globs.optional().describe("Utility prefixes that may take arbitrary values, e.g. tracking"),
      prefixes: Globs.optional().describe("Check exactly these utility prefixes instead of the default scale utilities"),
    }),
    "no-raw-style-value": rule({
      allow: z.array(z.number()).optional().describe("Raw numbers that are fine, default [0]"),
      scales: z.record(z.string(), Globs).optional().describe('Token groups per scale, e.g. { "spacing": ["space"] }'),
    }),
    "prefer-ds-component": rule(),
    "no-unknown-variant": rule(),
    "no-variant-override": rule({ allow: Globs.optional().describe("Exact classes that may override a variant, e.g. rounded-none") }),
    "restricted-import": rule(),
    "zone-tokens": rule(),
    "no-unknown-token": rule({ allow: Globs.optional().describe("Variable prefixes defined outside the project, e.g. --swiper-*") }),
    "spec-drift": rule(),
    "require-proposal": rule(),
  })
  .strict();

export const RULE_IDS = Object.keys(RulesSchema.shape);

const RestrictedImportSchema = z
  .object({
    from: Globs.describe('Module specifiers, e.g. ["lucide-react", "@radix-ui/**"]'),
    allowIn: Globs.describe("Files allowed to import them"),
    message: z.string().optional(),
  })
  .strict();

/** A part of the app with its own token set, e.g. marketing pages that use `landing-*` tokens. */
const ZoneSchema = z
  .object({
    name: z.string(),
    files: Globs,
    ignore: Globs.optional(),
    allowTokens: Globs.optional().describe("Token names (globs) allowed in this zone; anything else is reported"),
    denyTokens: Globs.optional().describe("Token names (globs) not allowed in this zone"),
    message: z.string().optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    presets: z.array(z.enum(["react", "react-native", "tailwind-v3", "tailwind-v4", "shadcn", "base-ui", "radix", "chakra", "mantine", "mui"])).default(["react"]),
    specDir: z.string().default("design").describe("Folder holding the spec"),
    include: Globs.default(["**/*.{js,jsx,ts,tsx,css,scss,less,vue,svelte}"]),
    exclude: Globs.default(["**/node_modules/**", "**/.next/**", "**/dist/**", "**/build/**", "**/out/**", "**/coverage/**", "**/*.d.ts"]),
    uiDir: z.string().default("src/components/ui").describe("The design system's components"),
    uiImport: z.string().default("@/components/ui").describe("Import path of uiDir: an alias (@/components/ui) or a workspace package (@acme/ui)"),
    uiPackages: Globs.default([]).describe("Design system packages from npm whose components are read from their type declarations, e.g. [\"@acme/ui\"]"),
    cssFiles: Globs.default([]).describe("CSS files defining tokens (local @imports are followed)"),
    themeFiles: Globs.default([]).describe("JS/TS modules exporting tokens, e.g. React Native themes: export const spacing = { md: 16 }"),
    tokenFiles: z
      .array(z.union([z.string(), z.object({ path: z.string(), mode: z.string().optional(), set: z.string().optional() }).strict()]))
      .default([])
      .describe('W3C DTCG or Tokens Studio JSON files, e.g. ["tokens/base.json", { "path": "tokens/dark.json", "mode": "dark" }]'),
    tailwindConfig: z.string().optional().describe("Tailwind v3 config mapping utilities to CSS variables"),
    zones: z.array(ZoneSchema).default([]),
    eslintAliases: z
      .record(z.string(), Globs)
      .default({})
      .describe('Honor eslint-disable comments for these ESLint rules, e.g. { "acme/design-tokens": ["no-palette-color"] }; ["*"] maps to every rule'),
    classFunctions: Globs.default(["cn", "clsx", "classnames", "cva", "tv", "twMerge", "twJoin"]).describe("Functions whose string arguments are class lists"),
    restrictedImports: z.array(RestrictedImportSchema).default([]),
    figma: z
      .object({
        fileKey: z.string().optional().describe("The Figma file holding the design system's variables"),
        modes: z.record(z.string(), z.string()).optional().describe('Figma mode name → code mode, e.g. { "Night": "dark" }; "base" for the default'),
        ignoreCollections: Globs.optional().describe("Figma collections to leave out of the comparison"),
      })
      .strict()
      .optional(),
    rules: RulesSchema.default({}),
  })
  .strict();

export type Config = z.output<typeof ConfigSchema>;
export type RuleLevel = z.infer<typeof Level>;
export type RestrictedImport = z.infer<typeof RestrictedImportSchema>;
export type Zone = z.infer<typeof ZoneSchema>;

export const CONFIG_FILE = "designspec.config.json";
export const SCHEMA_URL = "https://unpkg.com/designspec/schema.json";
export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

/** JSON Schema for designspec.config.json, for editor completion. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: "input" }) as Record<string, unknown>;
}

export class UserError extends Error {}

export async function loadConfig(root: string): Promise<Config> {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new UserError(`No ${CONFIG_FILE} found in ${root}. Run "designspec init" first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new UserError(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new UserError(`${CONFIG_FILE} is invalid:\n${problems.join("\n")}`);
  }
  return result.data;
}

export async function writeConfig(root: string, config: Partial<Config>): Promise<void> {
  await writeFile(path.join(root, CONFIG_FILE), `${JSON.stringify({ $schema: SCHEMA_URL, ...config }, null, 2)}\n`);
}

export function isReactNative(config: Config): boolean {
  return config.presets.includes("react-native");
}

/** Component libraries whose style props take theme color names (bg="brand.500"). */
export function hasStyleProps(config: Config): boolean {
  return config.presets.some((p) => p === "chakra" || p === "mantine" || p === "mui");
}

export function hasTailwind(config: Config): boolean {
  return config.presets.some((p) => p.startsWith("tailwind"));
}

export function ruleSetting(config: Config, id: string, fallback: RuleLevel): { level: RuleLevel; options: Record<string, unknown> } {
  const setting = (config.rules as Record<string, RuleLevel | [RuleLevel, Record<string, unknown>] | undefined>)[id];
  if (setting === undefined) return { level: fallback, options: {} };
  if (Array.isArray(setting)) return { level: setting[0], options: setting[1] ?? {} };
  return { level: setting, options: {} };
}
