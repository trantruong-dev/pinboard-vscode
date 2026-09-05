/**
 * The Pinboard panel: progress ribbon, grouped queue of cards, detail below, connection footer.
 *
 * A webview rather than a TreeView. A tree row renders an icon and one line of text, which clipped
 * a long note and lost it silently, and it cannot draw the ribbon, the status pills or the accent
 * bar the JetBrains build has. The trade is that the theme has to be followed by hand, which the
 * stylesheet does by dereferencing VS Code's own theme variables rather than naming colours.
 *
 * This class holds only what the panel needs and the store does not: which item is selected and
 * which groups are folded. Everything shown is derived in buildQueueState, which has no editor
 * imports and is tested directly.
 */

import * as vscode from 'vscode';

import { GROUP_ORDER, Status } from '../model/feedback';
import { FeedbackStore } from '../store/feedback-store';
import { StaleFlags } from '../capture/staleness';
import { ConnectionFacts, connectionView } from './connection';
import { buildQueueState } from './queue-state';

/** Finished work is history: it would otherwise push the items needing attention out of view. */
const COLLAPSED_BY_DEFAULT: Status[] = ['RESOLVED', 'DISMISSED'];

export interface QueueViewCallbacks {
    /** Open the pinned code. Double-clicking a card, as in the JetBrains list. */
    reveal(id: string): void;
    remove(id: string): void;
    copyMcpConfig(): void;
}

export class QueueViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view: vscode.WebviewView | undefined;
    private flags = new Map<string, StaleFlags>();
    private selectedId: string | null = null;
    private collapsed = new Set<Status>(COLLAPSED_BY_DEFAULT);
    private facts: ConnectionFacts = {
        serverRunning: false,
        url: null,
        sessions: 0,
        lastToolCallAt: null,
        lastToolName: null,
    };

    /**
     * Repaints the footer while nothing else changes, so "2m ago" does not sit at "2m ago" for an
     * hour. Coarse on purpose: the label only changes at minute boundaries.
     */
    private ticker: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: FeedbackStore,
        private readonly callbacks: QueueViewCallbacks,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage(message => this.onMessage(message));
        view.onDidDispose(() => {
            this.view = undefined;
        });
        this.startTicker();
    }

    /** Staleness is resolved once per refresh by the extension, so rendering never touches the disk. */
    setFlags(flags: Map<string, StaleFlags>): void {
        this.flags = flags;
        this.render();
    }

    setConnection(facts: ConnectionFacts): void {
        this.facts = facts;
        this.render();
    }

    /** The selected item, for the commands that act on "this one". */
    get selected(): string | null {
        return this.selectedId;
    }

    render(): void {
        if (!this.view) {
            return;
        }
        const items = GROUP_ORDER.flatMap(status =>
            this.store.byStatus([status]).sort((a, b) => b.createdAt - a.createdAt),
        );
        // A selection that was resolved away by an agent must not leave the detail pane showing a
        // card that is no longer in the queue.
        if (this.selectedId && !items.some(item => item.id === this.selectedId)) {
            this.selectedId = null;
        }
        const state = buildQueueState({
            items,
            flags: this.flags,
            connection: connectionView(this.facts),
            selectedId: this.selectedId,
            collapsed: this.collapsed,
        });
        void this.view.webview.postMessage({ type: 'state', state });
    }

    dispose(): void {
        if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = undefined;
        }
    }

    private startTicker(): void {
        if (this.ticker) {
            return;
        }
        this.ticker = setInterval(() => {
            if (this.view?.visible) {
                this.render();
            }
        }, 30_000);
    }

    private onMessage(message: { type?: string; id?: string | null; status?: Status }): void {
        switch (message.type) {
            case 'ready':
                this.render();
                return;
            case 'select':
                this.selectedId = message.id ?? null;
                this.render();
                return;
            case 'reveal':
                if (message.id) {
                    this.callbacks.reveal(message.id);
                }
                return;
            case 'delete':
                if (message.id) {
                    this.callbacks.remove(message.id);
                }
                return;
            case 'toggleGroup':
                if (message.status) {
                    if (this.collapsed.has(message.status)) {
                        this.collapsed.delete(message.status);
                    } else {
                        this.collapsed.add(message.status);
                    }
                    this.render();
                }
                return;
            case 'copyMcpConfig':
                this.callbacks.copyMcpConfig();
                return;
        }
    }

    private html(webview: vscode.Webview): string {
        const asset = (name: string): vscode.Uri =>
            webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
        // A nonce plus a policy that allows no inline script: the panel renders notes and code the
        // developer pinned and replies an agent wrote, none of which is trusted markup.
        const nonce = nonceOf();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('queue.css')}" rel="stylesheet">
<title>Pinboard</title>
</head>
<body>
<div id="ribbon" hidden><div class="bar" id="bar"></div><div class="legend" id="legend"></div></div>
<div id="queue" role="list"></div>
<div id="detail" hidden></div>
<div id="footer"></div>
<script nonce="${nonce}" src="${asset('queue.js')}"></script>
</body>
</html>`;
    }
}

function nonceOf(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i += 1) {
        text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
}
