/**
 * What the footer is allowed to say.
 *
 * The rule these tests hold to is that the chip reports only what was observed. A wrong "connected"
 * is worse than no chip at all: it sends the user looking for a bug in their agent when the truth
 * is that nothing ever reached the queue.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConnectionFacts, connectionView } from '../ui/connection';

const NOW = 1_700_000_000_000;

function facts(overrides: Partial<ConnectionFacts> = {}): ConnectionFacts {
    return {
        serverRunning: true,
        url: 'http://127.0.0.1:52791/mcp',
        sessions: 0,
        lastToolCallAt: null,
        lastToolName: null,
        ...overrides,
    };
}

test('a server that never started is the one state worth an error tone', () => {
    const view = connectionView(facts({ serverRunning: false, url: null }), NOW);
    assert.equal(view.tone, 'error');
    assert.match(view.detail, /could not start/i);
});

test('with nothing connected the footer names the address to attach to', () => {
    const view = connectionView(facts(), NOW);
    assert.equal(view.label, 'Waiting for agent');
    assert.equal(view.tone, 'waiting');
    assert.match(view.detail, /127\.0\.0\.1:52791/);
});

/**
 * A session is a client that completed an MCP handshake. Saying so is earned; saying it is working
 * is not, which is why this stays on the waiting tone until a call actually arrives.
 */
test('a connected client that has not called yet is reported as exactly that', () => {
    const view = connectionView(facts({ sessions: 1 }), NOW);
    assert.equal(view.label, 'Agent connected');
    assert.equal(view.tone, 'waiting');
    assert.match(view.detail, /nothing has called a tool yet/i);

    assert.equal(connectionView(facts({ sessions: 3 }), NOW).label, '3 agents connected');
});

test('a recent call reads as active and names the tool', () => {
    const view = connectionView(
        facts({ sessions: 1, lastToolCallAt: NOW - 30_000, lastToolName: 'feedback_list' }),
        NOW,
    );
    assert.equal(view.label, 'Agent active');
    assert.equal(view.tone, 'active');
    assert.equal(view.detail, 'Last call 30s ago · feedback_list');
});

/**
 * Ten minutes, not one: an agent working a single item runs tests and edits files between tool
 * calls, and a chip that flickered to Idle in those gaps would train the user to ignore it.
 */
test('the active window is wide enough to survive an agent thinking', () => {
    const nineMinutes = connectionView(facts({ lastToolCallAt: NOW - 9 * 60_000 }), NOW);
    assert.equal(nineMinutes.tone, 'active');

    const elevenMinutes = connectionView(facts({ lastToolCallAt: NOW - 11 * 60_000 }), NOW);
    assert.equal(elevenMinutes.label, 'Idle');
    assert.equal(elevenMinutes.tone, 'idle');
});

test('a call that arrived outranks a session count that has since dropped to zero', () => {
    const view = connectionView(
        facts({ sessions: 0, lastToolCallAt: NOW - 60_000, lastToolName: 'feedback_resolve' }),
        NOW,
    );
    assert.equal(view.label, 'Agent active', 'evidence of a call beats the absence of a live session');
});
