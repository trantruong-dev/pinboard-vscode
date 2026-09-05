/**
 * Drives the real server over real HTTP with the real MCP client.
 *
 * The unit tests above prove the rules; this proves the wiring - that the tools are actually
 * reachable by a client, with the names and schemas an agent will see. Nothing here is mocked
 * except the workspace file reader.
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { FeedbackStore } from '../store/feedback-store';
import { FeedbackTools } from '../mcp/feedback-tools';
import { RunningMcpServer, startMcpServer } from '../mcp/mcp-http-host';

let server: RunningMcpServer;
let store: FeedbackStore;
let client: Client;

/** Deliberately not the real version, so a literal left in the server code cannot pass by luck. */
const TEST_VERSION = '9.9.9-test';

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

/** Pulls the JSON payload back out of a tool result. */
function payload(result: unknown): any {
    const content = (result as { content: { type: string; text: string }[] }).content;
    return JSON.parse(content[0].text);
}

before(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pinboard-http-'));
    store = new FeedbackStore(join(dir, 'queue.json'));
    await store.load();
    server = await startMcpServer(
        new FeedbackTools(store, async () => 'zero\none\ntwo\n'),
        0,
        () => {},
        TEST_VERSION,
    );

    client = new Client({ name: 'pinboard-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
});

after(async () => {
    await client.close();
    await server.dispose();
    store.dispose();
});

test('the server binds to loopback only, so nothing off the machine can reach the queue', () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.ok(server.port > 0);
});

/**
 * The version a client reads back has to be the extension's own, not a literal in the server code.
 * A literal is right exactly once and silently wrong after the next release, which is what happened
 * between 0.0.1 and 0.0.2.
 */
test('the server reports the version it was started with', () => {
    assert.deepEqual(client.getServerVersion(), { name: 'pinboard', version: TEST_VERSION });
});

test('a client sees exactly the seven tools, under the documented names', async () => {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
        'feedback_acknowledge',
        'feedback_clear_resolved',
        'feedback_dismiss',
        'feedback_list',
        'feedback_reply',
        'feedback_resolve',
        'feedback_watch',
    ]);
});

test('every tool carries a description, since that is all an agent has to choose by', async () => {
    for (const tool of (await client.listTools()).tools) {
        assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a real description`);
    }
});

test('a full round trip: pin, list, acknowledge, resolve', async () => {
    const pinned = store.add(draft('the loop reallocates on every pass'));

    const listed = payload(await client.callTool({ name: 'feedback_list', arguments: {} }));
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, pinned.id);
    assert.equal(listed.items[0].note, 'the loop reallocates on every pass');
    assert.equal(listed.items[0].stale, false, 'staleness is computed for the agent, not stored');

    const acknowledged = payload(
        await client.callTool({ name: 'feedback_acknowledge', arguments: { ids: [pinned.id] } }),
    );
    assert.deepEqual(acknowledged.acknowledged, [pinned.id]);
    assert.equal(store.find(pinned.id)?.status, 'ACKNOWLEDGED');

    const resolved = payload(
        await client.callTool({
            name: 'feedback_resolve',
            arguments: { id: pinned.id, summary: 'Hoisted the allocation out of the loop.' },
        }),
    );
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.thread.at(-1).body, 'Hoisted the allocation out of the loop.');
});

test('watch delivers, in one call, a run of pins made while it was in flight', async () => {
    const inFlight = client.callTool({
        name: 'feedback_watch',
        arguments: { timeoutSeconds: 30, batchWindowSeconds: 1 },
    });
    setTimeout(() => store.add(draft('first')), 30);
    setTimeout(() => store.add(draft('second')), 300);

    const batch = payload(await inFlight);
    assert.deepEqual(
        batch.items.map((item: { note: string }) => item.note),
        ['first', 'second'],
        'both pins fall inside the batch window, so they arrive together',
    );
});

/**
 * More than one agent attaches at once as a matter of course - the editor's own, and whatever else
 * the developer has pointed at the queue. Every one of them opens its own MCP session.
 *
 * The SDK binds a single transport per server instance, so a server shared across sessions rejects
 * the second client with "Already connected to a transport" and it never gets a single tool call
 * through. One session's worth of testing cannot see that, which is how it reached a release.
 */
test('a second client gets its own session, and both see the one queue', async () => {
    const second = new Client({ name: 'pinboard-test-second', version: '0' });
    await second.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    try {
        const pinned = store.add(draft('seen from both sessions'));

        const fromSecond = payload(await second.callTool({ name: 'feedback_list', arguments: {} }));
        assert.ok(
            fromSecond.items.some((item: { id: string }) => item.id === pinned.id),
            'the second client must reach the tools at all',
        );

        // The first session has to keep working after the second one opens, and both are looking at
        // the same store rather than a copy of it.
        const fromFirst = payload(
            await client.callTool({ name: 'feedback_acknowledge', arguments: { ids: [pinned.id] } }),
        );
        assert.deepEqual(fromFirst.acknowledged, [pinned.id]);

        const afterAck = payload(await second.callTool({ name: 'feedback_list', arguments: {} }));
        const item = afterAck.items.find((entry: { id: string }) => entry.id === pinned.id);
        assert.equal(item.status, 'ACKNOWLEDGED');
    } finally {
        await second.close();
    }
});

test('resolving an id that does not exist answers with an error, not silence', async () => {
    const result = await client.callTool({
        name: 'feedback_resolve',
        arguments: { id: 'not-a-real-id', summary: 'x' },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
});

/**
 * The schema is the contract an agent is held to. A call missing a required field must not run the
 * tool at all - resolving with no summary would close the item and leave the developer nothing to
 * audit.
 */
test('resolve refuses a call with no summary, and leaves the item untouched', async () => {
    const item = store.add(draft('needs a summary'));
    const result = (await client.callTool({
        name: 'feedback_resolve',
        arguments: { id: item.id },
    })) as { isError?: boolean; content: { text: string }[] };

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /summary/i);
    assert.equal(store.find(item.id)?.status, 'PENDING', 'the tool must not have run');
    assert.deepEqual(store.find(item.id)?.thread, []);
});
