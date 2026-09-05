/**
 * The queue itself: the single source of truth for one workspace.
 *
 * Deliberately free of VS Code imports. It takes a plain file path and does its own IO, so the MCP
 * tools and the whole test suite can drive it with no editor running.
 *
 * Writes are debounced rather than immediate. Pinning five notes in a row should cost one write,
 * and an agent acknowledging a batch of twenty should not rewrite the file twenty times.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Feedback, Message, OPEN_STATUSES, Status, withMessage, withStatus } from '../model/feedback';

/** What lands on disk. Versioned so a later format can be recognised rather than guessed at. */
interface StoreFile {
    version: 1;
    items: Feedback[];
}

type Listener = () => void;

const FLUSH_DELAY_MS = 250;

export class FeedbackStore {
    private items: Feedback[] = [];
    private loaded = false;
    private flushTimer: NodeJS.Timeout | undefined;
    private writing: Promise<void> = Promise.resolve();
    private readonly listeners = new Set<Listener>();

    constructor(private readonly file: string) {}

    /** Reads the file once. A missing or unreadable file starts an empty queue rather than failing. */
    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        try {
            const raw = await readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw) as StoreFile;
            this.items = Array.isArray(parsed.items) ? parsed.items : [];
        } catch {
            // A first run has no file, and a corrupt one must not stop the extension loading. The
            // queue starts empty either way; the next write replaces whatever was there.
            this.items = [];
        }
    }

    onChanged(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    all(): Feedback[] {
        return [...this.items];
    }

    find(id: string): Feedback | undefined {
        return this.items.find(item => item.id === id);
    }

    byStatus(statuses: Status[]): Feedback[] {
        return this.items.filter(item => statuses.includes(item.status));
    }

    countByStatus(status: Status): number {
        return this.items.filter(item => item.status === status).length;
    }

    /** True when a file has anything still open, which is what tints its tab. */
    hasOpenItemFor(relativePath: string): boolean {
        return this.items.some(
            item => item.filePath === relativePath && OPEN_STATUSES.includes(item.status),
        );
    }

    /** Adds a pin. The id is generated here so no caller can invent a duplicate. */
    add(draft: Omit<Feedback, 'id' | 'status' | 'thread' | 'createdAt' | 'updatedAt'>): Feedback {
        const now = Date.now();
        const feedback: Feedback = {
            ...draft,
            id: randomUUID(),
            status: 'PENDING',
            thread: [],
            createdAt: now,
            updatedAt: now,
        };
        this.items = [...this.items, feedback];
        this.changed();
        return feedback;
    }

    /** Moves items to a status. Returns the ones that existed, so callers can report the rest. */
    setStatus(ids: string[], status: Status): Feedback[] {
        const wanted = new Set(ids);
        const touched: Feedback[] = [];
        this.items = this.items.map(item => {
            if (!wanted.has(item.id)) {
                return item;
            }
            const next = withStatus(item, status);
            touched.push(next);
            return next;
        });
        if (touched.length > 0) {
            this.changed();
        }
        return touched;
    }

    /** Appends to a thread without touching status, for a question or a summary. */
    appendMessage(id: string, message: Message): Feedback | undefined {
        let updated: Feedback | undefined;
        this.items = this.items.map(item => {
            if (item.id !== id) {
                return item;
            }
            updated = withMessage(item, message);
            return updated;
        });
        if (updated) {
            this.changed();
        }
        return updated;
    }

    /**
     * Moves line numbers after the code above a pin shifted.
     *
     * Skips anything already correct so an editing session does not rewrite the file on every
     * keystroke. Returns how many actually moved.
     */
    updateLocations(moves: Map<string, { startLine: number; endLine: number }>): number {
        let moved = 0;
        this.items = this.items.map(item => {
            const target = moves.get(item.id);
            if (!target || (item.startLine === target.startLine && item.endLine === target.endLine)) {
                return item;
            }
            moved++;
            // updatedAt is left alone on purpose: a line shift is not a change the developer made,
            // and bumping it would reorder the queue under them while they type.
            return { ...item, startLine: target.startLine, endLine: target.endLine };
        });
        if (moved > 0) {
            this.changed();
        }
        return moved;
    }

    remove(ids: string[]): number {
        const wanted = new Set(ids);
        const before = this.items.length;
        this.items = this.items.filter(item => !wanted.has(item.id));
        const removed = before - this.items.length;
        if (removed > 0) {
            this.changed();
        }
        return removed;
    }

    /** Deletes finished work only. Pending and acknowledged items are never touched here. */
    removeByStatus(statuses: Status[]): number {
        const before = this.items.length;
        this.items = this.items.filter(item => !statuses.includes(item.status));
        const removed = before - this.items.length;
        if (removed > 0) {
            this.changed();
        }
        return removed;
    }

    removeAll(): number {
        const removed = this.items.length;
        if (removed > 0) {
            this.items = [];
            this.changed();
        }
        return removed;
    }

    /** Writes now and waits for it. Used on shutdown, where a pending timer would be lost. */
    async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        await this.write();
    }

    dispose(): void {
        this.listeners.clear();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
    }

    private changed(): void {
        this.scheduleFlush();
        for (const listener of [...this.listeners]) {
            listener();
        }
    }

    private scheduleFlush(): void {
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.write();
        }, FLUSH_DELAY_MS);
    }

    /**
     * Serialises writes and replaces the file atomically.
     *
     * Writing in place would leave a half-written queue behind if the editor died mid-write, and
     * the queue is the only copy of what the developer asked for.
     */
    private write(): Promise<void> {
        const snapshot: StoreFile = { version: 1, items: this.items };
        this.writing = this.writing.then(async () => {
            const temporary = `${this.file}.tmp`;
            await mkdir(dirname(this.file), { recursive: true });
            await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
            await rename(temporary, this.file);
        });
        return this.writing;
    }
}
