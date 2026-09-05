/**
 * The queue in the sidebar: status groups, then the items under them.
 *
 * Finished groups start collapsed, because resolved work is history and would otherwise push the
 * pending items - the only ones that need attention - out of view.
 */

import * as vscode from 'vscode';

import { Feedback, GROUP_ORDER, Status, statusLabel, locationLabel } from '../model/feedback';
import { FeedbackStore } from '../store/feedback-store';
import { StaleFlags, NOT_STALE } from '../capture/staleness';

type Node = { kind: 'group'; status: Status; total: number } | { kind: 'item'; feedback: Feedback };

const COLLAPSED_BY_DEFAULT: Status[] = ['RESOLVED', 'DISMISSED'];

const STATUS_ICON: Record<Status, string> = {
    PENDING: 'circle-outline',
    ACKNOWLEDGED: 'sync',
    RESOLVED: 'pass-filled',
    DISMISSED: 'circle-slash',
};

export class QueueTreeProvider implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    /** Staleness is resolved once per refresh and cached, so rendering never touches the disk. */
    private flags = new Map<string, StaleFlags>();

    constructor(private readonly store: FeedbackStore) {}

    setFlags(flags: Map<string, StaleFlags>): void {
        this.flags = flags;
        this.changed.fire(undefined);
    }

    refresh(): void {
        this.changed.fire(undefined);
    }

    getChildren(node?: Node): Node[] {
        if (!node) {
            return GROUP_ORDER.map(status => ({
                kind: 'group' as const,
                status,
                total: this.store.countByStatus(status),
            })).filter(group => group.total > 0);
        }
        if (node.kind === 'group') {
            return this.store
                .byStatus([node.status])
                .sort((a, b) => b.createdAt - a.createdAt)
                .map(feedback => ({ kind: 'item' as const, feedback }));
        }
        return [];
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'group') {
            const item = new vscode.TreeItem(
                statusLabel(node.status),
                COLLAPSED_BY_DEFAULT.includes(node.status)
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.Expanded,
            );
            item.description = String(node.total);
            item.iconPath = new vscode.ThemeIcon(STATUS_ICON[node.status]);
            item.contextValue = 'pinboard.group';
            return item;
        }

        const { feedback } = node;
        const flags = this.flags.get(feedback.id) ?? NOT_STALE;
        const item = new vscode.TreeItem(firstLine(feedback.note));
        item.id = feedback.id;
        item.description = [locationLabel(feedback), warning(flags)].filter(Boolean).join('  ');
        item.tooltip = tooltip(feedback, flags);
        item.contextValue = 'pinboard.item';
        item.iconPath = new vscode.ThemeIcon(
            flags.fileMissing || flags.stale ? 'warning' : STATUS_ICON[feedback.status],
        );
        if (feedback.filePath && feedback.startLine !== null) {
            item.command = {
                command: 'pinboard.revealItem',
                title: 'Open the pinned code',
                arguments: [feedback.id],
            };
        }
        return item;
    }

    dispose(): void {
        this.changed.dispose();
    }
}

function warning(flags: StaleFlags): string {
    if (flags.fileMissing) {
        return 'file missing';
    }
    return flags.stale ? 'code changed' : '';
}

/** A tree row renders one line, so the note is reduced to its first sentence-ish. */
function firstLine(note: string): string {
    const collapsed = note.trim().replace(/\s+/g, ' ');
    return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

/** The full note and its thread, which is what a one-line row cannot show. */
function tooltip(feedback: Feedback, flags: StaleFlags): vscode.MarkdownString {
    const parts = [feedback.note.trim()];
    if (feedback.filePath) {
        parts.push('', `\`${locationLabel(feedback) ?? feedback.filePath}\``);
    }
    if (flags.fileMissing) {
        parts.push('', 'The file no longer exists. The snapshot is what was pinned.');
    } else if (flags.stale) {
        parts.push('', 'Code changed since this was pinned. Trust the snapshot, not the line numbers.');
    }
    for (const message of feedback.thread) {
        parts.push('', `**${message.author === 'HUMAN' ? 'You' : 'Agent'}**: ${message.body}`);
    }
    const markdown = new vscode.MarkdownString(parts.join('\n'));
    // The note is the developer's own text and the thread is the agent's: neither is trusted markup.
    markdown.supportHtml = false;
    return markdown;
}
