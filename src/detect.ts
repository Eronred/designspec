import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { glob } from "tinyglobby";
import path from "node:path";

export interface Detection {
  framework: "next" | "react" | "react-native" | null;
  tailwind: 3 | 4 | null;
  shadcn: boolean;
  headless: Array<"base-ui" | "radix">;
  componentLibraries: Array<"chakra" | "mantine" | "mui">;
  uiDir: string;
  uiImport: string;
  cssFiles: string[];
  themeFiles: string[];
  tokenFiles: string[];
  tailwindConfig?: string;
}

const THEME_DIRS = ["theme", "src/theme", "constants", "src/constants", "styles", "src/styles"];
const THEME_FILE = /^(index|colors?|spacing|radius|radii|typography|fonts?|shadows?|theme|tokens|sizes|layout)\.(ts|js)$/i;
const TAILWIND_CONFIGS = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];

const CSS_CANDIDATES = [
  "src/app/globals.css",
  "app/globals.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
  "src/globals.css",
];

export async function detect(root: string): Promise<Detection> {
  const pkg = await readJson(path.join(root, "package.json"));
  const deps: Record<string, string> = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const has = (name: string) => name in deps;
  const hasPrefix = (prefix: string) => Object.keys(deps).some((d) => d.startsWith(prefix));

  const shadcnConfig = await readJson(path.join(root, "components.json"));
  const aliases = shadcnConfig?.aliases ?? {};
  const aliasUiImport: string = aliases.ui ?? (aliases.components ? `${aliases.components}/ui` : "@/components/ui");
  const localUiDir =
    (shadcnConfig ? await resolveAlias(root, aliasUiImport) : undefined) ??
    ["src/components/ui", "components/ui", "src/ui", "ui"].find((d) => existsSync(path.join(root, d)));
  // A workspace design system package (packages/ui imported as @acme/ui) when the app has no UI folder of its own.
  const workspaceUi = localUiDir ? undefined : await findWorkspaceUiPackage(root, Object.keys(deps));
  const uiImport = workspaceUi?.name ?? aliasUiImport;
  const uiDir = localUiDir ?? workspaceUi?.dir ?? (await resolveAlias(root, aliasUiImport)) ?? "components/ui";

  const cssFiles: string[] = [];
  // SCSS / Less token files: _variables.scss, _tokens.scss, variables.less…
  const preprocessorTokens = (
    await glob(["**/{_,}{variables,tokens,colors,theme}.{scss,less}"], { cwd: root, ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] })
  ).sort();
  const shadcnCss: string | undefined = shadcnConfig?.tailwind?.css;
  if (shadcnCss && existsSync(path.join(root, shadcnCss))) cssFiles.push(toPosix(shadcnCss));
  else {
    const found = CSS_CANDIDATES.find((c) => existsSync(path.join(root, c)));
    if (found) cssFiles.push(found);
  }

  const tailwindMajor = /(\d+)/.exec(deps.tailwindcss ?? deps["@tailwindcss/postcss"] ?? deps["@tailwindcss/vite"] ?? "")?.[1];

  const isNative = has("react-native");
  const themeFiles: string[] = [];
  if (isNative) {
    for (const dir of THEME_DIRS) {
      if (!existsSync(path.join(root, dir))) continue;
      for (const file of (await readdir(path.join(root, dir))).sort()) {
        if (THEME_FILE.test(file) && !/^index\./.test(file)) themeFiles.push(`${dir}/${file}`);
      }
    }
  }

  // DTCG / Tokens Studio files: *.tokens.json, tokens/*.json, design-tokens.json (never our own design/tokens.json).
  const tokenFiles = (
    await glob(["**/*.tokens.json", "tokens/**/*.json", "src/tokens/**/*.json", "**/design-tokens.json"], {
      cwd: root,
      ignore: ["**/node_modules/**", "design/**", "**/dist/**", "**/build/**", "**/$metadata.json", "**/$themes.json"],
    })
  ).sort();

  const componentLibraries: Detection["componentLibraries"] = [];
  if (hasPrefix("@chakra-ui/")) componentLibraries.push("chakra");
  if (has("@mantine/core")) componentLibraries.push("mantine");
  if (has("@mui/material") || has("@mui/joy")) componentLibraries.push("mui");
  if (componentLibraries.length) {
    // The theme: createSystem (Chakra), createTheme (Mantine, MUI), extendTheme (older Chakra / MUI Joy).
    for (const file of (await glob(["**/theme.{ts,tsx,js}", "**/theme/index.{ts,tsx,js}"], { cwd: root, ignore: ["**/node_modules/**", "**/dist/**"] })).sort()) {
      if (/\b(createSystem|createTheme|extendTheme|defineConfig)\(/.test(await readFile(path.join(root, file), "utf8")) && !themeFiles.includes(file)) themeFiles.push(file);
    }
  }

  const headless: Detection["headless"] = [];
  if (hasPrefix("@base-ui-components/") || hasPrefix("@base-ui/")) headless.push("base-ui");
  if (has("radix-ui") || hasPrefix("@radix-ui/")) headless.push("radix");

  return {
    framework: isNative ? "react-native" : has("next") ? "next" : has("react") ? "react" : null,
    tailwind: tailwindMajor === "3" ? 3 : tailwindMajor && Number(tailwindMajor) >= 4 ? 4 : null,
    shadcn: shadcnConfig !== undefined,
    headless,
    componentLibraries,
    uiDir,
    uiImport,
    cssFiles: [...cssFiles, ...preprocessorTokens.filter((f) => !cssFiles.includes(f))],
    themeFiles,
    tokenFiles,
    tailwindConfig: tailwindMajor === "3" ? TAILWIND_CONFIGS.find((c) => existsSync(path.join(root, c))) : undefined,
  };
}

const UI_PACKAGE_NAME = /(^|[/-])(ui|design-system|designsystem|components|ds)$/;

/**
 * A dependency that is a workspace package in this repository (its node_modules entry links back into the
 * repo) and looks like a design system: `@acme/ui`, `@repo/design-system`. Returns its source folder.
 */
async function findWorkspaceUiPackage(root: string, deps: string[]): Promise<{ name: string; dir: string } | undefined> {
  for (const name of deps.filter((d) => UI_PACKAGE_NAME.test(d))) {
    // node_modules may be hoisted to a parent folder in a monorepo.
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
      const link = path.join(dir, "node_modules", name);
      if (existsSync(link)) {
        const real = await realpath(link);
        if (real.split(path.sep).includes("node_modules")) break; // installed from the registry, not a workspace
        const source = existsSync(path.join(real, "src")) ? path.join(real, "src") : real;
        // Relative to the real root too: on macOS /var is a link to /private/var.
        return { name, dir: toPosix(path.relative(await realpath(root), source)) };
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return undefined;
}

/** Resolves an import alias like `@/components/ui` to a project-relative directory via tsconfig `paths`. */
async function resolveAlias(root: string, specifier: string): Promise<string | undefined> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const tsconfig = await readJson(path.join(root, name));
    const options = tsconfig?.compilerOptions;
    if (!options?.paths) continue;
    const baseUrl: string = options.baseUrl ?? ".";
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, string[]>)) {
      const prefix = pattern.replace(/\*$/, "");
      if (!specifier.startsWith(prefix) || !targets[0]) continue;
      const rest = specifier.slice(prefix.length);
      return toPosix(path.normalize(path.join(baseUrl, targets[0].replace(/\*$/, "") + rest)));
    }
  }
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    const rest = specifier.slice(2);
    return existsSync(path.join(root, "src")) ? `src/${rest}` : rest;
  }
  return undefined;
}

/**
 * How `fromFile` should import `targetFile`: through a tsconfig path alias when one covers it
 * (`theme/index.ts` -> `@/theme`), else a relative path. Both are project-relative.
 */
export async function importSpecifier(root: string, fromFile: string, targetFile: string): Promise<string> {
  const target = targetFile.replace(/\.[jt]sx?$/, "").replace(/\/index$/, "");
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const options = (await readJson(path.join(root, name)))?.compilerOptions;
    if (!options?.paths) continue;
    const baseUrl = toPosix(options.baseUrl ?? ".").replace(/^\.$/, "");
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, string[]>)) {
      if (!pattern.endsWith("*") || !targets[0]?.endsWith("*")) continue;
      const dir = toPosix(path.posix.join(baseUrl, targets[0].slice(0, -1))).replace(/^\.\/?/, "").replace(/^\.$/, "");
      if (dir === "" || target.startsWith(dir.endsWith("/") ? dir : `${dir}/`)) {
        return pattern.slice(0, -1) + target.slice(dir === "" ? 0 : (dir.endsWith("/") ? dir : `${dir}/`).length);
      }
    }
  }
  const relative = path.posix.relative(path.posix.dirname(fromFile), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

// package.json, components.json and tsconfig.json are read loosely.
async function readJson(file: string): Promise<any> {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(stripJsonComments(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** tsconfig.json allows comments and trailing commas. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/").replace(/^\.\//, "");
}
