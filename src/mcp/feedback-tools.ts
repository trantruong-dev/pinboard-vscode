/**
 * The seven tools an agent sees, and the rules they enforce.
 *
 * Registered onto an McpServer, but every operation is expressed against the store and a resolver
 * for current file text, so the whole surface can be driven from tests with no socket and no editor.
 *
 * The boundary worth stating: an agent can read the queue and close items, but cannot create
 * feedback and cannot delete anything still open. The queue is the developer's record of what they
 * asked for, and an agent that could quietly clear work it had not finished would destroy the only
 * copy of it.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Feedback, OPEN_STATUSES, Status } from '../model/feedback';
import { FeedbackStore } from '../store/feedback-store';
import { StaleFlags, flagsFor } from '../capture/staleness';

/** Reads a workspace file as it is right now, or null when it is gone. */
export type TextResolver = (relativePath: string) => Promise<string | null>;

/** One item as an agent receives it: the stored fields plus the flags it must act on. */
export interface FeedbackView extends Feedback, StaleFlags {}

/**
 * What the reading tools return.
 *
 * `totalPending` is carried even on an empty batch on purpose: it is how an agent that called
 * `feedback_watch` and timed out learns there is a backlog sitting there from before the call, and
 * that it should read the queue with `feedback_list` instead of waiting again.
 */
export interface ListResult {
    items: FeedbackView[];
    totalPending: number;
}

const DEFAULT_WATCH_SECONDS = 60;
const MAX_WATCH_SECONDS = 300;
const DEFAULT_BATCH_WINDOW_SECONDS = 5;
const MAX_BATCH_WINDOW_SECONDS = 60;

export class FeedbackTools {
    constructor(
        private readonly store: FeedbackStore,
        private readonly readText: TextResolver,
    ) {}

    /** Decorates items with staleness, which is computed on read rather than stored. */
    async view(items: Feedback[]): Promise<FeedbackView[]> {
        const texts = new Map<string, string | null>();
        const views: FeedbackView[] = [];
        for (const item of items) {
            let text: string | null = null;
            if (item.filePath) {
                if (!texts.has(item.filePath)) {
                    texts.set(item.filePath, await this.readText(item.filePath));
                }
                text = texts.get(item.filePath) ?? null;
            }
            views.push({ ...item, ...flagsFor(item, text) });
        }
        return views;
    }

    async list(statuses: Status[]): Promise<ListResult> {
        return this.result(this.store.byStatus(statuses));
    }

    /**
     * Blocks until something new is pinned, then returns the whole cluster at once.
     *
     * Two decisions make this the batching primitive rather than a slow poll:
     *
     * Only items pinned *after* the call count as new. Otherwise the loop `watch -> acknowledge ->
     * work -> watch` would hand back the same items on the next pass, and an agent would work them
     * twice. A backlog from before the call is read with `feedback_list`, and `totalPending` on the
     * empty batch is what tells the agent that backlog is there.
     *
     * After the first arrival it waits out a short window before returning. A developer reviewing a
     * file pins several things in a row; returning on the first one would turn one review into five
     * round trips, which is the exact problem this plugin exists to remove.
     */
    async watch(
        statuses: Status[],
        timeoutSeconds: number,
        batchWindowSeconds: number,
        signal?: AbortSignal,
    ): Promise<ListResult> {
        const seconds = clamp(timeoutSeconds, 1, MAX_WATCH_SECONDS);
        const window = clamp(batchWindowSeconds, 1, MAX_BATCH_WINDOW_SECONDS);
        const known = new Set(this.store.all().map(item => item.id));
        const fresh = (): Feedback[] =>
            this.store.byStatus(statuses).filter(item => !known.has(item.id));

        const sawSomething = await new Promise<boolean>(resolve => {
            const finish = (value: boolean) => {
                clearTimeout(timer);
                unsubscribe();
                signal?.removeEventListener('abort', onAbort);
                resolve(value);
            };
            const timer = setTimeout(() => finish(false), seconds * 1000);
            const onAbort = () => finish(false);
            const unsubscribe = this.store.onChanged(() => {
                if (fresh().length > 0) {
                    finish(true);
                }
            });
            signal?.addEventListener('abort', onAbort, { once: true });
        });

        if (!sawSomething) {
            return this.result([]);
        }

        await sleep(window * 1000, signal);
        return this.result(fresh().sort((a, b) => a.createdAt - b.createdAt));
    }

    acknowledge(ids: string[]): Feedback[] {
        return this.store.setStatus(ids, 'ACKNOWLEDGED');
    }

    /** Closing an item needs a summary. "Fixed" tells the developer nothing they can audit. */
    resolve(id: string, summary: string): Feedback | undefined {
        const updated = this.store.setStatus([id], 'RESOLVED');
        if (updated.length === 0) {
            return undefined;
        }
        return this.store.appendMessage(id, {
            author: 'AGENT',
            body: summary,
            createdAt: Date.now(),
        });
    }

    /** Declining is a real answer. It beats leaving an item pending forever. */
    dismiss(id: string, reason: string): Feedback | undefined {
        const updated = this.store.setStatus([id], 'DISMISSED');
        if (updated.length === 0) {
            return undefined;
        }
        return this.store.appendMessage(id, {
            author: 'AGENT',
            body: reason,
            createdAt: Date.now(),
        });
    }

    /** Adds a question without changing status, so the item stays in the developer's queue. */
    reply(id: string, body: string): Feedback | undefined {
        return this.store.appendMessage(id, { author: 'AGENT', body, createdAt: Date.now() });
    }

    /**
     * Deletes finished items only.
     *
     * Never call this automatically after a batch: the resolved summaries are how the developer
     * audits what was done, and they need to outlive the task.
     */
    clearResolved(): number {
        return this.store.removeByStatus(['RESOLVED', 'DISMISSED']);
    }

    private async result(items: Feedback[]): Promise<ListResult> {
        return { items: await this.view(items), totalPending: this.store.countByStatus('PENDING') };
    }
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high);
}

/** A sleep that gives up early if the client hangs up, so a cancelled call does not linger. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

function asText(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

const statusEnum = z.enum(['PENDING', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']);

/** Wires the tools onto a server instance. One call, so the transport layer stays thin. */
export function registerFeedbackTools(server: McpServer, tools: FeedbackTools): void {
    server.registerTool(
        'feedback_list',
        {
            title: 'List pinned feedback',
            description:
                'The current queue of feedback the developer pinned in their editor. Returns PENDING and ACKNOWLEDGED items unless other statuses are asked for. Does not block.',
            inputSchema: {
                statuses: z
                    .array(statusEnum)
                    .optional()
                    .describe('Which statuses to return. Defaults to PENDING and ACKNOWLEDGED.'),
            },
        },
        async ({ statuses }) => asText(await tools.list(statuses ?? OPEN_STATUSES)),
    );

    server.registerTool(
        'feedback_watch',
        {
            title: 'Wait for new feedback',
            description:
                'Blocks until the developer pins something NEW, then waits a short window to collect the rest of the cluster and returns them as one batch. Prefer this over polling. It only returns items pinned after the call, so check totalPending on an empty batch: if it is above zero there is a backlog from before, and feedback_list is what reads it. An empty batch is a normal answer - call it again. Keep timeoutSeconds comfortably under your own tool-call timeout.',
            inputSchema: {
                timeoutSeconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_WATCH_SECONDS)
                    .optional()
                    .describe(`How long to block. Defaults to ${DEFAULT_WATCH_SECONDS} seconds.`),
                batchWindowSeconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_BATCH_WINDOW_SECONDS)
                    .optional()
                    .describe(
                        `How long to keep collecting after the first item arrives, so a run of pins comes back as one batch. Defaults to ${DEFAULT_BATCH_WINDOW_SECONDS} seconds.`,
                    ),
                statuses: z
                    .array(statusEnum)
                    .optional()
                    .describe('Which statuses to watch for. Defaults to PENDING and ACKNOWLEDGED.'),
            },
        },
        async ({ timeoutSeconds, batchWindowSeconds, statuses }, extra) =>
            asText(
                await tools.watch(
                    statuses ?? OPEN_STATUSES,
                    timeoutSeconds ?? DEFAULT_WATCH_SECONDS,
                    batchWindowSeconds ?? DEFAULT_BATCH_WINDOW_SECONDS,
                    extra?.signal,
                ),
            ),
    );

    server.registerTool(
        'feedback_acknowledge',
        {
            title: 'Mark feedback as seen',
            description:
                'Tells the developer you have picked these up and are working on them. Takes the whole batch in one call. Acknowledged is not finished: if you restart mid-task, these are the items you had already started.',
            inputSchema: {
                ids: z.array(z.string()).min(1).describe('Ids of the items you have read.'),
            },
        },
        async ({ ids }) => {
            const updated = tools.acknowledge(ids);
            const missing = ids.filter(id => !updated.some(item => item.id === id));
            return asText({ acknowledged: updated.map(item => item.id), unknownIds: missing });
        },
    );

    server.registerTool(
        'feedback_resolve',
        {
            title: 'Close feedback with a summary',
            description:
                'Closes an item. The summary is stored in its thread and is how the developer checks your work, so name the change you made rather than saying "fixed".',
            inputSchema: {
                id: z.string().describe('Id of the item you finished.'),
                summary: z.string().min(1).describe('What you actually did.'),
            },
        },
        async ({ id, summary }) => {
            const updated = tools.resolve(id, summary);
            return updated ? asText(updated) : unknownId(id);
        },
    );

    server.registerTool(
        'feedback_dismiss',
        {
            title: 'Close feedback without acting',
            description:
                'Closes an item you decided not to act on. Dismissing with a reason is a real answer and is better than leaving an item pending forever.',
            inputSchema: {
                id: z.string().describe('Id of the item you are declining.'),
                reason: z.string().min(1).describe('Why you are not acting on it.'),
            },
        },
        async ({ id, reason }) => {
            const updated = tools.dismiss(id, reason);
            return updated ? asText(updated) : unknownId(id);
        },
    );

    server.registerTool(
        'feedback_reply',
        {
            title: 'Ask the developer a question',
            description:
                'Adds a message to an item thread and leaves its status alone, so the item stays in the developer queue with your question attached. Use it when you need something before you can act.',
            inputSchema: {
                id: z.string().describe('Id of the item you have a question about.'),
                body: z.string().min(1).describe('Your question or note.'),
            },
        },
        async ({ id, body }) => {
            const updated = tools.reply(id, body);
            return updated ? asText(updated) : unknownId(id);
        },
    );

    server.registerTool(
        'feedback_clear_resolved',
        {
            title: 'Delete finished feedback',
            description:
                'Deletes items that are already RESOLVED or DISMISSED. Only call this when the developer explicitly asks you to tidy up. Never after a batch: the summaries are how they audit what you did.',
            inputSchema: {},
        },
        async () => asText({ deleted: tools.clearResolved() }),
    );
}

function unknownId(id: string) {
    return {
        isError: true,
        content: [
            {
                type: 'text' as const,
                text: `No feedback item with id ${id}. It may have been deleted. Call feedback_list to see what is there.`,
            },
        ],
    };
}
