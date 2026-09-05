---
name: pinboard
description: Pick up and work through code feedback the developer pinned from inside their editor. Use whenever a feedback_list / feedback_watch tool is available and the developer mentions feedback, pinned notes, review comments, or things they marked up - and after finishing a coding task in a project where those tools exist, to check whether they left anything.
---

# Pinboard

The developer pins feedback onto specific lines from inside their editor. Each item carries the
note, the file, the line range, and a verbatim snapshot of the code as it looked when they pinned
it. Your job is to work through that queue and report back into it.

The tools arrive over MCP and need no setup on your side.

**Finding them:** the base names are `feedback_list`, `feedback_watch`, `feedback_acknowledge`,
`feedback_resolve`, `feedback_dismiss`, `feedback_reply`, `feedback_clear_resolved`. Your client may
expose them under a prefix taken from the server's configured name, so the same tool can read as
`mcp__pinboard__feedback_list`. Match on the `feedback_` part, not on an exact string - if you look
for a bare `feedback_watch` and find nothing, look again for the suffix before concluding the plugin
is missing.

## Picking work up

**Start with `feedback_list`.** It returns the current queue immediately. This matters because
`feedback_watch` only reports items pinned *after* you called it, so anything the developer pinned
before you started is invisible to `watch` and would be missed.

`feedback_watch` then blocks until something new is pinned, waits a few seconds to collect the rest
of the cluster, and returns them as one batch. Prefer it over polling. It is built to be called in a
loop: it returns an empty batch when nothing arrived, and you call it again.

Both return `{ items, totalPending }`. **Read `totalPending` on an empty batch.** Above zero means
there is a backlog from before your call, and `feedback_list` is what reads it.

Keep `timeoutSeconds` comfortably under your own tool-call timeout. The editor will block for
minutes without complaint, but the MCP client gives up first and the call is lost. The default of
60s is chosen for that reason - raise it only if you know your client allows it.

By default both return **PENDING and ACKNOWLEDGED** items. Read the `status` field on each item:

- `PENDING` - nobody has looked at it
- `ACKNOWLEDGED` - you have seen it but have not finished it. **Not done.** If you restart mid-task,
  these are the items you already started; pick them back up.

## Working an item

Call `feedback_acknowledge` with the ids as soon as you have read a batch. It takes an array, so
acknowledge the whole batch in one call. This is what tells the developer you are on it.

Then read the item:

- `codeSnapshot` is the code as it was when they pinned it. This is the source of truth for *what
  they were looking at*.
- `filePath`, `startLine`, `endLine` locate it. Lines are 1-based and inclusive.
- `symbolPath` names the enclosing symbol, for example `Calculator#add`.

**When `stale` is true, the file changed after they pinned it.** Do not trust the line numbers. Use
`codeSnapshot` to know what they meant and `symbolPath` to find where that code lives now. If you
cannot relocate it confidently, say so in a reply rather than guessing at the wrong lines.

**When `fileMissing` is true, the file is gone entirely** - renamed, moved, or deleted. Say so
instead of inventing a location.

## Reporting back

Every item you finish needs `feedback_resolve` with a `summary` of what you actually did. The
summary is stored in the item's thread and is how the developer checks your work. A summary that
just says "fixed" is useless to them; name the change.

If you decide not to act on an item, use `feedback_dismiss` with a `reason`. Dismissing is a real
answer - it is better than leaving an item pending forever.

If you need something from the developer before you can act, use `feedback_reply`. This adds a
message to the thread and leaves the status alone, so the item stays in their queue with your
question attached.

## What you cannot do

You cannot create feedback, and you cannot delete anything that is still pending or acknowledged.
That boundary is deliberate: the queue is the developer's record of what they asked for, and an
agent quietly clearing work it did not finish would destroy the only copy.

`feedback_clear_resolved` deletes items that are already RESOLVED or DISMISSED. **Only call it when
the developer explicitly asks you to tidy up.** Never call it automatically after a batch - the
resolved summaries are how they audit what you did, and they need to outlive the task.

## When the queue is empty

An empty batch is a normal answer, not a failure. If the developer asked you to check and there is
nothing pending, say so and stop - do not sit in a `feedback_watch` loop waiting for them to type
something into the editor. Loop only while you are actively working through a queue that has items
in it, or while the developer has asked you to keep watching.

## A normal loop

1. `feedback_list` - read anything already waiting
2. `feedback_acknowledge` with every id you picked up
3. For each item: read `codeSnapshot`, check `stale` and `fileMissing`, do the work
4. `feedback_resolve` with a real summary, or `feedback_dismiss` with a reason, or `feedback_reply`
   if you are blocked on a question
5. `feedback_watch` - block for the next batch, then back to 2
