/**
 * What the panel shows, as plain data.
 *
 * The webview renders this and nothing else, so the grouping, the counts, the wording and the
 * progress arithmetic are all testable without an editor host or a browser. Building it here also
 * keeps the posted message small: the webview never sees a code snapshot it is not displaying.
 */

import {
    Feedback,
    GROUP_ORDER,
    Status,
    isOpen,
    locationLabel,
    statusLabel,
} from '../model/feedback';
import { StaleFlags } from '../capture/staleness';
import { ConnectionView } from './connection';
import { relativeTime } from './relative-time';
import { Tone, toneOf, warningFor } from './status-appearance';

/** Longest note the card shows before it is clipped. The detail pane has the whole thing. */
const NOTE_CHARS = 220;

/** Longest code line the card previews. One line is enough to tell two cards apart at a glance. */
const SNIPPET_CHARS = 60;

export interface CardState {
    id: string;
    tone: Tone;
    /** `thing.ts:40-52`, or null for a project-scoped note. */
    location: string | null;
    /** `stale` or `file missing`, on open items only. */
    warning: string | null;
    note: string;
    /** First non-blank line of the snapshot, clipped. Null when nothing was captured. */
    snippet: string | null;
    age: string;
    /** Full note and path, for the native tooltip on a clipped card. */
    tooltip: string;
}

export interface GroupState {
    status: Status;
    label: string;
    count: number;
    cards: CardState[];
}

export interface RibbonSegment {
    key: 'done' | 'acknowledged' | 'pending';
    label: string;
    tone: Tone;
    count: number;
}

export interface DetailMessage {
    who: string;
    age: string;
    body: string;
}

export interface DetailState {
    id: string;
    /** Full workspace-relative path with lines, not the short file name the card shows. */
    location: string;
    status: string;
    tone: Tone;
    age: string;
    /** The warning spelled out, or null. */
    banner: string | null;
    note: string;
    /** Whether the note can still be rewritten - true only while the agent has not taken it. */
    editable: boolean;
    code: string | null;
    language: string | null;
    truncated: boolean;
    symbolPath: string | null;
    thread: DetailMessage[];
}

export interface QueueState {
    groups: GroupState[];
    ribbon: RibbonSegment[];
    /** Zero means the ribbon and the groups are hidden and the empty state shows instead. */
    total: number;
    connection: ConnectionView;
    selectedId: string | null;
    detail: DetailState | null;
    collapsed: Status[];
}

export interface QueueInputs {
    items: Feedback[];
    flags: Map<string, StaleFlags>;
    connection: ConnectionView;
    selectedId: string | null;
    collapsed: Set<Status>;
    now?: number;
}

export function buildQueueState(inputs: QueueInputs): QueueState {
    const now = inputs.now ?? Date.now();
    const flagsFor = (id: string): StaleFlags => inputs.flags.get(id) ?? { stale: false, fileMissing: false };

    const groups: GroupState[] = [];
    for (const status of GROUP_ORDER) {
        const inGroup = inputs.items.filter(item => item.status === status);
        if (inGroup.length === 0) {
            continue;
        }
        groups.push({
            status,
            label: statusLabel(status),
            count: inGroup.length,
            cards: inputs.collapsed.has(status)
                ? []
                : inGroup.map(item => toCard(item, flagsFor(item.id), now)),
        });
    }

    const selected = inputs.selectedId
        ? inputs.items.find(item => item.id === inputs.selectedId) ?? null
        : null;

    return {
        groups,
        ribbon: ribbonOf(inputs.items),
        total: inputs.items.length,
        connection: inputs.connection,
        selectedId: selected?.id ?? null,
        detail: selected ? toDetail(selected, flagsFor(selected.id), now) : null,
        collapsed: [...inputs.collapsed],
    };
}

function toCard(item: Feedback, flags: StaleFlags, now: number): CardState {
    return {
        id: item.id,
        tone: toneOf(item.status),
        location: locationLabel(item),
        warning: warningFor(item.status, flags),
        note: clip(collapseWhitespace(item.note), NOTE_CHARS),
        snippet: firstMeaningfulLine(item.codeSnapshot),
        age: relativeTime(item.createdAt, now),
        tooltip: item.filePath ? `${item.note.trim()}\n${item.filePath}` : item.note.trim(),
    };
}

function toDetail(item: Feedback, flags: StaleFlags, now: number): DetailState {
    return {
        id: item.id,
        location: fullLocation(item),
        status: statusLabel(item.status),
        tone: toneOf(item.status),
        age: relativeTime(item.createdAt, now),
        banner: bannerFor(item.status, flags),
        note: item.note.trim(),
        editable: item.status === 'PENDING',
        code: item.codeSnapshot,
        language: item.language,
        truncated: item.truncated,
        symbolPath: item.symbolPath,
        thread: item.thread.map(message => ({
            who: message.author === 'HUMAN' ? 'You' : 'Agent',
            age: relativeTime(message.createdAt, now),
            body: message.body,
        })),
    };
}

/**
 * The detail pane says what the warning means, where the card only had room to name it. The
 * snapshot stays authoritative either way - this is exactly the case symbolPath exists to recover
 * from.
 */
function bannerFor(status: Status, flags: StaleFlags): string | null {
    if (!isOpen(status)) {
        return null;
    }
    if (flags.fileMissing) {
        return 'The file no longer exists. The snapshot below is what was pinned.';
    }
    if (flags.stale) {
        return 'Code changed since this was pinned. Line numbers may be wrong; trust the snapshot below.';
    }
    return null;
}

function fullLocation(item: Feedback): string {
    if (item.scope === 'PROJECT') {
        return 'Whole project';
    }
    if (!item.filePath) {
        return 'Unknown location';
    }
    if (item.startLine === null) {
        return item.filePath;
    }
    if (item.endLine !== null && item.endLine !== item.startLine) {
        return `${item.filePath}:${item.startLine}-${item.endLine}`;
    }
    return `${item.filePath}:${item.startLine}`;
}

/**
 * How much of the queue is done. A count per group is already in the headers; this answers the
 * different question of how the review as a whole is going, which is otherwise arithmetic the user
 * has to do in their head.
 *
 * Order is left to right: what is done, then what is in flight, then what is owed.
 */
function ribbonOf(items: Feedback[]): RibbonSegment[] {
    const count = (statuses: Status[]): number =>
        items.filter(item => statuses.includes(item.status)).length;
    return [
        { key: 'done', label: 'Done', tone: 'done', count: count(['RESOLVED', 'DISMISSED']) },
        { key: 'acknowledged', label: 'Acknowledged', tone: 'active', count: count(['ACKNOWLEDGED']) },
        { key: 'pending', label: 'Pending', tone: 'pending', count: count(['PENDING']) },
    ];
}

/** Skips blank leading lines so the preview is code rather than indentation. */
function firstMeaningfulLine(snapshot: string | null): string | null {
    if (!snapshot) {
        return null;
    }
    const line = snapshot.split('\n').find(candidate => candidate.trim().length > 0);
    return line ? clip(line.trim(), SNIPPET_CHARS) : null;
}

function collapseWhitespace(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
