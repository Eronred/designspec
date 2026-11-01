---
"designspec-kit": patch
---

Fixes found running designspec on a production monorepo:

- Fully transparent colors (`rgba(0,0,0,0)`, `#0000`) count as `transparent`, not as hardcoded colors.
- `doctor` shows the app's own MCP server in a monorepo, not the first designspec server in `.mcp.json`.
- `explore` counts the same color once (`#fff`, `#FFF`, `#ffffff`, `bg-[#fff]`) and keeps React Native keys as written (`borderRadius`).
- `preview --diff` and the PR comment list tokens whose type changed.
- `sync` says "changed type from color to other" instead of "is a other token, not color".
- `require-proposal` docs and the `sync` hint match what the rule does: a proposal is needed when the UI directory or token sources change, not for spec-only updates such as `sync` after upgrading.
