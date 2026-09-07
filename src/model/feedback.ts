/**
 * The shape of one pinned note, and the only place its vocabulary is defined.
 *
 * Kept as plain data with no VS Code imports, so the store, the MCP tools and the tests can all use
 * it without an editor host.
 */

/** Where an item is in its life. */
export type Status = 'PENDING' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';

/** What a pin points at. */
export type Scope = 'SELECTION' | 'FILE' | 'PROJECT';

/** Who wrote a message in a thread. */
export type Author = 'HUMAN' | 'AGENT';

export interface Message {
    author: Author;
    body: string;
    createdAt: number;
}

export interface Feedback {
    id: string;
    status: Status;
    scope: Scope;
    /** What the developer asked for. The reason the item exists. */
    note: string;
    /** Workspace-relative, forward slashes. Null for project-scoped notes. */
    filePath: string | null;
    language: string | null;
    /** 1-based and inclusive, matching what an editor shows. */
    startLine: number | null;
    endLine: number | null;
    /** The code as it read when pinned. Stays authoritative when the file moves on. */
    codeSnapshot: string | null;
    /** Hash of the snapshot, so drift can be detected without keeping a second copy. */
    contentSha256: string | null;
    truncated: boolean;
    /** Enclosing symbol, e.g. `Calculator#add`, for relocating a snapshot that moved. */
    symbolPath: string | null;
    vcsRevision: string | null;
    thread: Message[];
    createdAt: number;
    updatedAt: number;
}

/** Render order for the queue. Finished work sits last because it is history, not work. */
export const GROUP_ORDER: Status[] = ['PENDING', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'];

/** Statuses an agent is expected to act on. */
export const OPEN_STATUSES: Status[] = ['PENDING', 'ACKNOWLEDGED'];

export function isOpen(status: Status): boolean {
    return OPEN_STATUSES.includes(status);
}

export function statusLabel(status: Status): string {
    switch (status) {
        case 'PENDING':
            return 'Pending';
        case 'ACKNOWLEDGED':
            return 'Acknowledged';
        case 'RESOLVED':
            return 'Resolved';
        case 'DISMISSED':
            return 'Dismissed';
    }
}

/**
 * `Foo.kt:40-52` for a range, `Foo.kt:40` for one line, `Foo.kt` for a whole file.
 *
 * Returns null for project scope, which has no location to show.
 */
export function locationLabel(feedback: Feedback): string | null {
    if (feedback.scope === 'PROJECT' || !feedback.filePath) {
        return null;
    }
    const name = feedback.filePath.split('/').pop() ?? feedback.filePath;
    if (feedback.startLine === null) {
        return name;
    }
    if (feedback.endLine !== null && feedback.endLine !== feedback.startLine) {
        return `${name}:${feedback.startLine}-${feedback.endLine}`;
    }
    return `${name}:${feedback.startLine}`;
}

export function withStatus(feedback: Feedback, status: Status): Feedback {
    return { ...feedback, status, updatedAt: Date.now() };
}

export function withNote(feedback: Feedback, note: string): Feedback {
    return { ...feedback, note, updatedAt: Date.now() };
}

export function withMessage(feedback: Feedback, message: Message): Feedback {
    return { ...feedback, thread: [...feedback.thread, message], updatedAt: Date.now() };
}
