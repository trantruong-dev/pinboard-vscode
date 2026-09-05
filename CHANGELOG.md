# Changelog

## [0.0.3](https://github.com/trantruong-dev/pinboard-vscode/compare/v0.0.2...v0.0.3) (2026-09-05)

### Added

* rebuild the panel to match the JetBrains one ([03ac9f5](https://github.com/trantruong-dev/pinboard-vscode/commit/03ac9f577a7461050928d811510683297facae93))

### Fixed

* report the installed version to MCP clients ([d2ef1c7](https://github.com/trantruong-dev/pinboard-vscode/commit/d2ef1c7d1e11b4a1bcf1f53bdd0e95e5bf738808))
## [0.0.2](https://github.com/trantruong-dev/pinboard-vscode/compare/v0.0.1...v0.0.2) (2026-09-05)

### Fixed

* give every MCP session its own server instance ([0d91222](https://github.com/trantruong-dev/pinboard-vscode/commit/0d91222b0d495e922160f597a71858ce45775979))
## [0.0.1]

First release.
The VS Code build of Pinboard, which already exists for JetBrains IDEs.

### Added

- Pin a selection or a whole file with a note, from the keyboard, the editor context menu, the
  editor tab, or the Explorer.
- A queue view in the activity bar, grouped by status, with the agent's replies in the tooltip and
  a click to jump back to the code.
- Editor decorations for pinned ranges, including the overview ruler, in a warning colour once the
  code underneath changes.
- Pins follow the code: an edit above a pin moves it, so only a real change to the pinned lines
  marks it stale.
- An MCP server hosted inside the extension, on `127.0.0.1`, published to VS Code through
  `mcpServerDefinitionProviders` so Copilot discovers it with no configuration.
  VS Code is an MCP client and has no server of its own to add tools to, which is where this
  differs from the JetBrains plugin.
- Seven MCP tools: `feedback_list`, `feedback_watch`, `feedback_acknowledge`, `feedback_resolve`,
  `feedback_dismiss`, `feedback_reply`, `feedback_clear_resolved`.
  `feedback_watch` blocks for new pins, waits out a batch window to collect the cluster, and returns
  it in one call.
- **Copy MCP Server Config**, for attaching an agent other than Copilot.
- A skill, installable with `npx skills add trantruong-dev/pinboard-vscode` or through Claude Code's
  plugin system, that teaches an agent when to reach for the queue.
- Settings for the server port and the longest code snapshot stored with a pin.
