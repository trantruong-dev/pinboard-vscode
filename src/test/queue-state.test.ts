/**
 * What the panel decides to show, tested without a browser or an editor host.
 *
 * The webview only turns this into DOM, so everything worth getting wrong - the grouping, the
 * counts, the wording, which items warn - is decided here and checked here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Feedback, Status } from '../model/feedback';
import { StaleFlags } from '../capture/staleness';
import { connectionView } from '../ui/connection';
import { relativeTime } from '../ui/relative-time';
import { toneOf, warningFor } from '../ui/status-appearance';
import { buildQueueState } from '../ui/queue-state';

const NOW = 1_700_000_000_000;

function item(overrides: Partial<Feedback> = {}): Feedback {
    return {
        id: 'id-1',
        status: 'PENDING',
        scope: 'SELECTION',
        note: 'the loop reallocates on every pass',
        filePath: 'src/thing.ts',
        language: 'typescript',
        startLine: 40,
        endLine: 52,
        codeSnapshot: '\n\n  const x = 1;\n  const y = 2;',
        contentSha256: 'sha',
        truncated: false,
        symbolPath: null,
        vcsRevision: null,
        thread: [],
        createdAt: NOW - 60_000,
        updatedAt: NOW - 60_000,
        ...overrides,
    };
}

function build(items: Feedback[], flags = new Map<string, StaleFlags>(), selectedId: string | null = null) {
    return buildQueueState({
        items,
        flags,
        connection: connectionView(
            { serverRunning: true, url: 'http://127.0.0.1:1/mcp', sessions: 0, lastToolCallAt: null, lastToolName: null },
            NOW,
        ),
        selectedId,
        collapsed: new Set<Status>(),
        now: NOW,
    });
}

test('relative time is coarse, and never negative when a clock is skewed', () => {
    assert.equal(relativeTime(NOW, NOW), 'just now');
    assert.equal(relativeTime(NOW - 30_000, NOW), '30s ago');
    assert.equal(relativeTime(NOW - 5 * 60_000, NOW), '5m ago');
    assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), '3h ago');
    assert.equal(relativeTime(NOW - 2 * 86_400_000, NOW), '2d ago');
    assert.equal(relativeTime(NOW + 60_000, NOW), 'just now', 'a future stamp is not a negative age');
});

test('a status maps to one tone everywhere, so the ribbon and the card cannot disagree', () => {
    assert.equal(toneOf('PENDING'), 'pending');
    assert.equal(toneOf('ACKNOWLEDGED'), 'active');
    assert.equal(toneOf('RESOLVED'), 'done');
    assert.equal(toneOf('DISMISSED'), 'done');
});

/**
 * A resolved item pointing at code that has since changed is the expected outcome of the agent
 * doing the work. Flagging it would make every finished item look broken.
 */
test('only open items warn about stale code', () => {
    const stale: StaleFlags = { stale: true, fileMissing: false };
    assert.equal(warningFor('PENDING', stale), 'stale');
    assert.equal(warningFor('ACKNOWLEDGED', stale), 'stale');
    assert.equal(warningFor('RESOLVED', stale), null);
    assert.equal(warningFor('DISMISSED', stale), null);
    assert.equal(warningFor('PENDING', { stale: true, fileMissing: true }), 'file missing');
    assert.equal(warningFor('PENDING', { stale: false, fileMissing: false }), null);
});

test('groups appear in queue order, and an empty group is not rendered at all', () => {
    const state = build([
        item({ id: 'a', status: 'RESOLVED' }),
        item({ id: 'b', status: 'PENDING' }),
        item({ id: 'c', status: 'PENDING' }),
    ]);
    assert.deepEqual(
        state.groups.map(group => [group.status, group.count]),
        [
            ['PENDING', 2],
            ['RESOLVED', 1],
        ],
        'no ACKNOWLEDGED or DISMISSED header when there is nothing under it',
    );
});

test('a collapsed group keeps its count but renders no cards', () => {
    const state = buildQueueState({
        items: [item({ id: 'a', status: 'RESOLVED' })],
        flags: new Map(),
        connection: connectionView(
            { serverRunning: true, url: null, sessions: 0, lastToolCallAt: null, lastToolName: null },
            NOW,
        ),
        selectedId: null,
        collapsed: new Set<Status>(['RESOLVED']),
        now: NOW,
    });
    assert.equal(state.groups[0].count, 1);
    assert.deepEqual(state.groups[0].cards, []);
});

test('a card shows the short location, a code line and an age', () => {
    const [card] = build([item()]).groups[0].cards;
    assert.equal(card.location, 'thing.ts:40-52');
    assert.equal(card.snippet, 'const x = 1;', 'blank leading lines are skipped so the preview is code');
    assert.equal(card.age, '1m ago');
    assert.equal(card.warning, null);
});

test('a one-line pin does not render a range, and a project note has no location', () => {
    const single = build([item({ startLine: 7, endLine: 7 })]).groups[0].cards[0];
    assert.equal(single.location, 'thing.ts:7');

    const project = build([item({ scope: 'PROJECT', filePath: null, startLine: null, endLine: null })])
        .groups[0].cards[0];
    assert.equal(project.location, null);
});

test('a long note is clipped on the card, and the tooltip carries the whole thing', () => {
    const note = 'x'.repeat(400);
    const [card] = build([item({ note })]).groups[0].cards;
    assert.ok(card.note.length < note.length, 'the card clips');
    assert.ok(card.note.endsWith('…'));
    assert.ok(card.tooltip.includes(note), 'the tooltip does not');
});

test('the ribbon counts the whole queue, done first', () => {
    const state = build([
        item({ id: 'a', status: 'PENDING' }),
        item({ id: 'b', status: 'ACKNOWLEDGED' }),
        item({ id: 'c', status: 'RESOLVED' }),
        item({ id: 'd', status: 'DISMISSED' }),
    ]);
    assert.deepEqual(
        state.ribbon.map(segment => [segment.key, segment.count]),
        [
            ['done', 2],
            ['acknowledged', 1],
            ['pending', 1],
        ],
        'resolved and dismissed are both done',
    );
    assert.equal(state.total, 4);
});

test('an empty queue has no groups and nothing to show progress on', () => {
    const state = build([]);
    assert.deepEqual(state.groups, []);
    assert.equal(state.total, 0);
});

test('the detail pane spells out the full path and the whole note', () => {
    const long = 'y'.repeat(400);
    const state = build([item({ note: long })], new Map(), 'id-1');
    assert.equal(state.detail?.location, 'src/thing.ts:40-52', 'not the short file name the card shows');
    assert.equal(state.detail?.note, long, 'not clipped');
    assert.equal(state.detail?.status, 'Pending');
});

test('a selection that an agent resolved away does not leave a stale detail pane', () => {
    const state = build([item({ id: 'still-here' })], new Map(), 'deleted-id');
    assert.equal(state.selectedId, null);
    assert.equal(state.detail, null);
});

test('the detail banner explains the warning, and only for open items', () => {
    const flags = new Map([['id-1', { stale: true, fileMissing: false }]]);
    const open = build([item()], flags, 'id-1');
    assert.match(open.detail!.banner!, /trust the snapshot/i);

    const closed = build([item({ status: 'RESOLVED' })], flags, 'id-1');
    assert.equal(closed.detail?.banner, null);
});

test('a thread is rendered with who said it and when', () => {
    const state = build(
        [
            item({
                thread: [
                    { author: 'AGENT', body: 'Hoisted the allocation.', createdAt: NOW - 30_000 },
                    { author: 'HUMAN', body: 'Thanks.', createdAt: NOW - 5_000 },
                ],
            }),
        ],
        new Map(),
        'id-1',
    );
    assert.deepEqual(
        state.detail?.thread.map(message => [message.who, message.age]),
        [
            ['Agent', '30s ago'],
            ['You', '5s ago'],
        ],
    );
});
