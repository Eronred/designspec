// Copies docs/*.md into the designspec skill's references, so the skill works without the repository.
// `npm run skills` writes them; `--check` (run by the tests) fails when they're out of date.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const REPO = "https://github.com/Eronred/designspec/blob/main/";

function skillReferences() {
  return readdirSync(`${root}docs`)
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({
      file: `skills/designspec/references/${file}`,
      content: readFileSync(`${root}docs/${file}`, "utf8").replaceAll("](../", `](${REPO}`),
    }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const { file, content } of skillReferences()) {
    if (!check) writeFileSync(`${root}${file}`, content);
    else if (!existsSync(`${root}${file}`) || readFileSync(`${root}${file}`, "utf8") !== content) stale.push(file);
  }
  if (stale.length) {
    console.error(`Out of date with docs/ (run npm run skills): ${stale.join(", ")}`);
    process.exit(1);
  }
}
