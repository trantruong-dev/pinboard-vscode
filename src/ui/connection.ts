/**
 * What the connection chip is allowed to say. Pure, so the wording and the thresholds are testable
 * without an editor host.
 *
 * The JetBrains plugin rides the IDE's own MCP server and cannot ask it whether a client is
 * attached, so it never says "connected" - a connected/disconnected claim there would be a guess
 * dressed up as a fact. This build hosts the server itself and counts its own sessions, so it may
 * say so. The rule is the same in both: report only what is observed.
 */

import { relativeTime } from './relative-time';

export type ConnectionTone =
    /** An agent called a tool recently. */
    | 'active'
    /** Nothing has called yet. */
    | 'waiting'
    /** An agent called before, but not lately. Normal between tasks, not a problem. */
    | 'idle'
    /** The user has to do something. */
    | 'error';

export interface ConnectionView {
    label: string;
    tone: ConnectionTone;
    detail: string;
}

export interface ConnectionFacts {
    /** False when the server failed to bind. Every tool call fails until that is fixed. */
    serverRunning: boolean;
    /** The address clients attach to, for the footer. Null while the server is down. */
    url: string | null;
    /** MCP sessions currently open. Evidence a client attached, not that it is working. */
    sessions: number;
    lastToolCallAt: number | null;
    lastToolName: string | null;
}

/**
 * How recent a call has to be for the agent to read as active.
 *
 * Ten minutes, not one: an agent working a single item runs tests and edits files between tool
 * calls, and a chip that flickered to Idle in those gaps would train the user to ignore it.
 */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export function connectionView(facts: ConnectionFacts, now: number = Date.now()): ConnectionView {
    if (!facts.serverRunning) {
        return {
            label: 'Server not running',
            tone: 'error',
            detail: 'Pinboard could not start its MCP server - agents cannot see this queue',
        };
    }

    if (facts.lastToolCallAt === null) {
        // A session is a client that completed an MCP handshake, which is more than "waiting" but
        // less than working. Saying which of the two it is beats one label covering both.
        if (facts.sessions > 0) {
            return {
                label: facts.sessions === 1 ? 'Agent connected' : `${facts.sessions} agents connected`,
                tone: 'waiting',
                detail: 'Connected, but nothing has called a tool yet',
            };
        }
        return {
            label: 'Waiting for agent',
            tone: 'waiting',
            detail: facts.url ? `Listening on ${facts.url} - no agent has connected yet` : 'No agent has connected yet',
        };
    }

    const age = relativeTime(facts.lastToolCallAt, now);
    const tool = facts.lastToolName ? ` · ${facts.lastToolName}` : '';
    if (now - facts.lastToolCallAt <= ACTIVE_WINDOW_MS) {
        return { label: 'Agent active', tone: 'active', detail: `Last call ${age}${tool}` };
    }
    return { label: 'Idle', tone: 'idle', detail: `Last call ${age}${tool}` };
}
