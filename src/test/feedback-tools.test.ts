import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FeedbackStore } from '../store/feedback-store';
import { FeedbackTools } from '../mcp/feedback-tools';

const FILE_TEXT = ['zero', 'one', 'two', 'three'].join('\n');

async function tools(text: string | null = FILE_TEXT) {
    const dir = await mkdtemp(join(tmpdir(), 'pinboard-tools-'));
    const store = new FeedbackStore(join(dir, 'queue.json'));
    await store.load();
    return { store, tools: new FeedbackTools(store, async () => text) };
}

function draft(note: string) {
    return {
        scope: 'SELECTION' as const,
        note,
        filePath: 'src/thing.ts',
        language: 'typescript',
        startLine: 2,
        endLine: 3,
        codeSnapshot: 'one\ntwo',
        contentSha256: 'sha',
        truncated: false,
        symbolPath: null,
        vcsRevision: null,
    };
}

test('list returns open items decorated with staleness', async () => {
    const context = await tools();
    context.store.add(draft('one'));
    const { items } = await context.tools.list(['PENDING', 'ACKNOWLEDGED']);
    assert.equal(items.length, 1);
    assert.equal(items[0].stale, false);
    assert.equal(items[0].fileMissing, false);
});

test('an item whose file vanished is handed to the agent flagged, not hidden', async () => {
    const context = await tools(null);
    context.store.add(draft('one'));
    const [item] = (await context.tools.list(['PENDING'])).items;
    assert.equal(item.fileMissing, true);
    assert.equal(item.stale, true);
    assert.equal(item.codeSnapshot, 'one\ntwo', 'the snapshot must survive the file');
});

test('resolving records the summary in the thread, which is what the developer audits', async () => {
    const context = await tools();
    const item = context.store.add(draft('one'));
    const updated = context.tools.resolve(item.id, 'Replaced the loop with a map lookup.');
    assert.equal(updated?.status, 'RESOLVED');
    assert.equal(updated?.thread.at(-1)?.body, 'Replaced the loop with a map lookup.');
    assert.equal(updated?.thread.at(-1)?.author, 'AGENT');
});

test('dismissing records the reason', async () => {
    const context = await tools();
    const item = context.store.add(draft('one'));
    const updated = context.tools.dismiss(item.id, 'Intentional, see the comment above.');
    assert.equal(updated?.status, 'DISMISSED');
    assert.equal(updated?.thread.at(-1)?.body, 'Intentional, see the comment above.');
});

test('replying leaves the item in the queue with the question attached', async () => {
    const context = await tools();
    const item = context.store.add(draft('one'));
    const updated = context.tools.reply(item.id, 'Which of the two callers did you mean?');
    assert.equal(updated?.status, 'PENDING');
    assert.equal(updated?.thread.length, 1);
});

test('an unknown id is reported rather than silently doing nothing', async () => {
    const context = await tools();
    assert.equal(context.tools.resolve('nope', 'summary'), undefined);
    assert.equal(context.tools.dismiss('nope', 'reason'), undefined);
    assert.equal(context.tools.reply('nope', 'body'), undefined);
});

/**
 * The boundary that protects the developer's record of what they asked for: an agent can close work
 * but cannot delete anything still open.
 */
test('clearing finished work leaves pending and acknowledged items alone', async () => {
    const context = await tools();
    const pending = context.store.add(draft('pending'));
    const working = context.store.add(draft('in progress'));
    const done = context.store.add(draft('done'));
    context.tools.acknowledge([working.id]);
    context.tools.resolve(done.id, 'did it');

    assert.equal(context.tools.clearResolved(), 1);
    const left = context.store.all().map(item => item.id).sort();
    assert.deepEqual(left, [pending.id, working.id].sort());
});

test('acknowledging takes a whole batch in one call', async () => {
    const context = await tools();
    const ids = [1, 2, 3].map(n => context.store.add(draft(`note ${n}`)).id);
    assert.equal(context.tools.acknowledge(ids).length, 3);
    assert.equal(context.store.countByStatus('ACKNOWLEDGED'), 3);
});

test('watch blocks until something is pinned, then returns it', async () => {
    const context = await tools();
    const pending = context.tools.watch(['PENDING'], 30, 1);
    setTimeout(() => context.store.add(draft('arrived late')), 20);
    const batch = await pending;
    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0].note, 'arrived late');
});

/**
 * Batching is the whole point. A developer reviewing a file pins several things in a row, and
 * returning on the first one would turn one review into a round trip per note.
 */
test('watch keeps collecting during the batch window, so a run of pins arrives together', async () => {
    const context = await tools();
    const pending = context.tools.watch(['PENDING'], 30, 1);
    setTimeout(() => context.store.add(draft('first')), 10);
    setTimeout(() => context.store.add(draft('second')), 300);
    setTimeout(() => context.store.add(draft('third')), 600);

    const batch = await pending;
    assert.deepEqual(
        batch.items.map(item => item.note),
        ['first', 'second', 'third'],
        'everything pinned inside the window belongs to one batch, oldest first',
    );
});

/** An empty batch is a normal answer. The caller simply asks again. */
test('watch returns an empty batch when nothing arrives before the timeout', async () => {
    const context = await tools();
    const batch = await context.tools.watch(['PENDING'], 1, 1);
    assert.deepEqual(batch.items, []);
});

/**
 * Only items pinned after the call are new. Without this the loop watch -> acknowledge -> watch
 * would hand the same items back and the agent would work them twice.
 */
test('watch ignores items that were already in the queue when it started', async () => {
    const context = await tools();
    context.store.add(draft('old'));
    const batch = await context.tools.watch(['PENDING'], 1, 1);
    assert.deepEqual(batch.items, [], 'an item present at the start is not new');
});

/** The way an agent that timed out learns a backlog is sitting there from before its call. */
test('an empty batch still reports how many items are pending', async () => {
    const context = await tools();
    context.store.add(draft('waiting from before'));
    const batch = await context.tools.watch(['PENDING'], 1, 1);
    assert.equal(batch.items.length, 0);
    assert.equal(batch.totalPending, 1);
});

test('an aborted watch stops waiting instead of holding the call open', async () => {
    const context = await tools();
    const controller = new AbortController();
    const pending = context.tools.watch(['PENDING'], 300, 60, controller.signal);
    controller.abort();
    assert.deepEqual((await pending).items, []);
});
