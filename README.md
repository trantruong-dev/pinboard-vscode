# Pinboard for VS Code

Pin feedback onto several pieces of code, then tell your agent to work through the lot.

The VS Code build of [Pinboard](https://github.com/trantruong-dev/pinboard), which does the same
thing for JetBrains IDEs.

## Why this exists

An agent can already see your current selection. That is a synchronous, one-shot channel: you point
at something, the agent looks at it, the moment is gone.

Reviewing code is not like that. You read through a file and spot five things. You want to note all
five, keep reading, and hand the batch over when you are done - and you want a record of what you
asked for and what the agent did about it.

That is what this extension adds:

- **A queue.** Pin as many notes as you like, whenever you like. Nothing is sent yet.
- **Batching.** The agent picks up a cluster of feedback in one call instead of one round trip each.
- **Threads.** The agent replies, asks questions, and records what it did.
- **It survives a restart.** Close the editor, reopen it, the queue is still there with its history.
- **A stale flag.** If the code moved or changed after you pinned it, the agent is told so, and is
  given the original snapshot and the enclosing symbol to relocate from.

## How it differs from the JetBrains build

JetBrains IDEs ship an MCP **server**, and the plugin there simply adds tools to it. VS Code is an
MCP **client**: it consumes servers, it does not host one. So this extension runs its own MCP server
inside the extension host, built on the official
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), and publishes it to
the editor through `vscode.lm.registerMcpServerDefinitionProvider`.

For you that difference is invisible: Copilot discovers the tools with nothing to configure. It
matters for other agents, which point at the server's URL - see below.

## Requirements

- **VS Code 1.101 or newer.** That is the release where the API for an extension to publish an MCP
  server became stable, and this extension is built on it.
- An MCP-capable agent. GitHub Copilot works out of the box; any other MCP client can attach.

## Install

From the Marketplace: search for **Pinboard**, install, and open a folder. No configuration.

The MCP server starts with the extension, listening on `127.0.0.1` on a port the operating system
picks. Copilot is handed that address automatically.

## Use

**Pin a selection.** Select code, then press `Ctrl+Alt+Shift+F` (`Cmd+Alt+Shift+F` on macOS), or
right-click and choose **Pin for Agent**. Type your note.

**Pin a whole file.** Right-click the file in the Explorer or its editor tab, **Pin File for Agent**.

**See your pins in the code.** A pinned range is tinted and marked in the overview ruler, and turns
a warning colour once the code under it changes. Editing above a pin moves it with the code rather
than reporting it stale.

**Review the queue.** The **Pinboard** view in the activity bar shows everything grouped by status,
with the agent's replies in the tooltip. Click an item to jump back to the code. Delete one with the
inline button; **Clear Finished Items** removes resolved and dismissed work in bulk.

## Teaching your agent when to use it

The tools are available as soon as the extension is installed, but an agent will not know when to
reach for them. The skill tells it to pick up batches, how to read the `stale` flag, and to close
each item with a summary you can audit.

One command, whichever agent you use:

```bash
npx skills add trantruong-dev/pinboard-vscode
```

Through Claude Code's own plugin system instead:

```
/plugin marketplace add trantruong-dev/pinboard-vscode
/plugin install pinboard@trantruong-dev
/reload-plugins
```

Or copy [`skills/pinboard/SKILL.md`](skills/pinboard/SKILL.md) into your agent's instructions by
hand.

## Connecting an agent other than Copilot

Run **Pinboard: Copy MCP Server Config** from the command palette and paste the result into your
client. It produces the standard shape:

```json
{
  "mcpServers": {
    "pinboard": { "type": "http", "url": "http://127.0.0.1:<port>/mcp" }
  }
}
```

The port changes each time VS Code restarts, because the operating system picks a free one. If you
are writing a config by hand and want the address to stay put, set `pinboard.mcpServer.port` to a
fixed number.

## The tools

| Tool | What it does |
|---|---|
| `feedback_list` | Current queue. Pending and acknowledged by default. Returns immediately |
| `feedback_watch` | Blocks until new items are pinned, collects the cluster, returns it as one batch |
| `feedback_acknowledge` | Marks items as seen. Takes a whole batch at once |
| `feedback_resolve` | Closes an item with a required summary of what was done |
| `feedback_dismiss` | Closes an item with a required reason for not acting |
| `feedback_reply` | Adds a question or note to an item's thread, status unchanged |
| `feedback_clear_resolved` | Deletes items that are already resolved or dismissed |

`feedback_watch` only reports items pinned **after** the call, so that acknowledging a batch and
watching again does not hand back the same work twice. Its result carries `totalPending`, which is
how an agent that timed out learns there is a backlog to read with `feedback_list`.

**The agent cannot create feedback, and cannot delete anything still pending.** The queue is your
record of what you asked for. An agent that could quietly clear work it had not finished would
destroy the only copy of it.

## Where your data goes

Nowhere. The extension makes no outbound network calls and collects no telemetry.

The queue is stored as JSON in the extension's own storage directory, one file per workspace, named
from a hash of the workspace path. It sits **outside your repository**, so it can never land in a
commit. **It contains verbatim source code** - the snapshot of everything you pin - so treat that
directory with the same care as the repository itself.

The MCP server is bound to `127.0.0.1`, so nothing off your machine can reach it, and it validates
the `Host` header on every request so that a web page cannot reach it through your browser either.

## Building from source

```bash
npm install
npm test        # unit tests plus a real MCP round trip over HTTP
npm run package # produces a .vsix
```

Requires Node 18 or newer.

`npm run release` cuts a version: it reads the conventional-commit messages since the last tag,
bumps `package.json`, writes the new section of `CHANGELOG.md`, commits, and tags. The changelog is
generated, so edit the commit messages rather than the file.

## Support this extension

Pinboard is free and always will be. If it saves you time, you can
[buy me a coffee](https://buymeacoffee.com/trantruong.dev).

## License

[Apache-2.0](LICENSE)
