/**
 * Wiring. Everything with real behaviour lives in its own module; this file only connects them to
 * the editor and decides the order things start in.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { FeedbackStore } from './store/feedback-store';
import { storeFileName } from './store/store-paths';
import { draftFromFile, draftFromSelection, relativePath } from './capture/capture';
import { StaleFlags, flagsFor } from './capture/staleness';
import { LineEdit, shiftRangeAll } from './capture/anchors';
import { FeedbackTools } from './mcp/feedback-tools';
import { RunningMcpServer, startMcpServer } from './mcp/mcp-http-host';
import { PinboardServerDefinitionProvider } from './mcp/server-definition';
import { QueueViewProvider } from './ui/queue-view';
import { PinDecorations, rangeOf } from './ui/decorations';

let store: FeedbackStore | undefined;
let server: RunningMcpServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Pinboard');
    context.subscriptions.push(output);

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        // Nothing to pin onto. The extension stays dormant rather than creating a stray queue.
        output.appendLine('No workspace folder open; Pinboard is idle.');
        return;
    }

    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const file = path.join(context.globalStorageUri.fsPath, storeFileName(folder.uri.fsPath));
    store = new FeedbackStore(file);
    await store.load();
    output.appendLine(`Queue: ${file}`);

    const tree = new QueueViewProvider(context.extensionUri, store, {
        reveal: id => void vscode.commands.executeCommand('pinboard.revealItem', id),
        remove: id => store!.remove([id]),
        edit: id => void vscode.commands.executeCommand('pinboard.editItem', id),
        copyMcpConfig: () => void vscode.commands.executeCommand('pinboard.copyMcpConfig'),
    });
    const decorations = new PinDecorations(store);
    context.subscriptions.push(decorations, tree);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('pinboard.queue', tree, {
            // The queue keeps its selection and its folded groups while the panel is hidden, so
            // coming back to it does not silently reset what the user was looking at.
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    const readText = async (relative: string): Promise<string | null> => {
        try {
            const uri = vscode.Uri.joinPath(folder.uri, ...relative.split('/'));
            const bytes = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(bytes).toString('utf8');
        } catch {
            return null;
        }
    };

    /** Recomputes staleness for the whole queue, then repaints everything that shows it. */
    const refresh = async (): Promise<void> => {
        const flags = new Map<string, StaleFlags>();
        const texts = new Map<string, string | null>();
        for (const item of store!.all()) {
            let text: string | null = null;
            if (item.filePath) {
                if (!texts.has(item.filePath)) {
                    texts.set(item.filePath, await readText(item.filePath));
                }
                text = texts.get(item.filePath) ?? null;
            }
            flags.set(item.id, flagsFor(item, text));
        }
        tree.setFlags(flags);
        decorations.refresh(flags);
        await vscode.commands.executeCommand(
            'setContext',
            'pinboard.pendingCount',
            store!.countByStatus('PENDING'),
        );
    };

    context.subscriptions.push({ dispose: store.onChanged(() => void refresh()) });
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(() => void refresh()),
        vscode.workspace.onDidChangeTextDocument(event => onDocumentChanged(event)),
    );

    registerCommands(context, folder, store, tree, output, refresh);

    // The server starts last: the definition provider is registered first so the editor has
    // something to ask, and is told to ask again once the port is known.
    const definitions = new PinboardServerDefinitionProvider(() => server?.url ?? null);
    context.subscriptions.push(definitions);
    context.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider('pinboard.mcp', definitions),
    );

    const tools = new FeedbackTools(store, readText);
    const port = vscode.workspace.getConfiguration('pinboard').get<number>('mcpServer.port', 0);
    try {
        server = await startMcpServer(
            tools,
            port,
            message => output.appendLine(`[mcp] ${message}`),
            // Read from the manifest so the version a client sees is the installed one, rather than
            // a literal that has to be remembered at every release.
            String(context.extension.packageJSON.version),
        );
        definitions.announce();
        // The footer says only what has been observed, so it is driven by the server's own record of
        // sessions and tool calls rather than an assumption that a client is out there.
        const running = server;
        const publish = (): void =>
            tree.setConnection({ serverRunning: true, url: running.url, ...running.observe() });
        running.onActivity(publish);
        publish();
    } catch (error) {
        output.appendLine(`[mcp] failed to start: ${String(error)}`);
        tree.setConnection({
            serverRunning: false,
            url: null,
            sessions: 0,
            lastToolCallAt: null,
            lastToolName: null,
        });
        void vscode.window.showErrorMessage(
            `Pinboard could not start its MCP server: ${String(error)}. Agents will not see the queue.`,
        );
    }

    await refresh();
}

export async function deactivate(): Promise<void> {
    await server?.dispose();
    server = undefined;
    // Flush before the process goes: a debounced write still in flight would lose the last pin.
    await store?.flush();
    store?.dispose();
    store = undefined;
}

/**
 * Moves pins when the lines above them change.
 *
 * VS Code gives content changes rather than persistent markers, so the new position is computed
 * from the edit. An edit that lands on the pinned lines themselves moves nothing - that is a
 * content change, and staleness reports it.
 */
function onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (!store || event.contentChanges.length === 0) {
        return;
    }
    const relative = relativePath(event.document.uri);
    if (relative === null) {
        return;
    }

    const edits: LineEdit[] = event.contentChanges.map(change => ({
        startLine: change.range.start.line + 1,
        endLine: change.range.end.line + 1,
        newLineCount: change.text.split('\n').length,
    }));

    const moves = new Map<string, { startLine: number; endLine: number }>();
    for (const item of store.all()) {
        if (item.filePath !== relative || item.startLine === null || item.endLine === null) {
            continue;
        }
        const moved = shiftRangeAll({ startLine: item.startLine, endLine: item.endLine }, edits);
        if (moved) {
            moves.set(item.id, moved);
        }
    }
    store.updateLocations(moves);
}

function registerCommands(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    queue: FeedbackStore,
    tree: QueueViewProvider,
    output: vscode.OutputChannel,
    refresh: () => Promise<void>,
): void {
    const maxLines = () =>
        vscode.workspace.getConfiguration('pinboard').get<number>('snippet.maxLines', 400);

    const askForNote = (
        placeholder: string,
        seed?: { value: string; title: string },
    ): Thenable<string | undefined> =>
        vscode.window.showInputBox({
            title: seed?.title ?? 'Pin for Agent',
            prompt: 'What should the agent do here?',
            placeHolder: placeholder,
            value: seed?.value,
            ignoreFocusOut: true,
            validateInput: value => (value.trim().length === 0 ? 'A note is required.' : undefined),
        });

    context.subscriptions.push(
        vscode.commands.registerCommand('pinboard.pinSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                void vscode.window.showWarningMessage('Open a file and select some code first.');
                return;
            }
            const note = await askForNote('e.g. this loop reallocates on every pass');
            if (!note) {
                return;
            }
            const draft = await draftFromSelection(editor, note.trim(), maxLines(), null);
            if (!draft) {
                void vscode.window.showWarningMessage(
                    'That file is outside the workspace, so it cannot be pinned.',
                );
                return;
            }
            queue.add(draft);
        }),

        vscode.commands.registerCommand('pinboard.pinFile', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                void vscode.window.showWarningMessage('No file to pin.');
                return;
            }
            const note = await askForNote('e.g. this module needs splitting up');
            if (!note) {
                return;
            }
            const draft = draftFromFile(target, note.trim(), null);
            if (!draft) {
                void vscode.window.showWarningMessage(
                    'That file is outside the workspace, so it cannot be pinned.',
                );
                return;
            }
            queue.add(draft);
        }),

        vscode.commands.registerCommand('pinboard.revealItem', async (id: string) => {
            const feedback = queue.find(id);
            if (!feedback?.filePath) {
                return;
            }
            const uri = vscode.Uri.joinPath(folder.uri, ...feedback.filePath.split('/'));
            try {
                const document = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(document);
                const range = rangeOf(feedback, document);
                if (range) {
                    editor.selection = new vscode.Selection(range.start, range.end);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                }
            } catch {
                void vscode.window.showWarningMessage(
                    `${feedback.filePath} no longer exists. The snapshot in the pin is what was there.`,
                );
            }
        }),

        vscode.commands.registerCommand('pinboard.editItem', async (id?: string) => {
            const target = id ?? tree.selected;
            const feedback = target ? queue.find(target) : undefined;
            if (!feedback) {
                return;
            }
            if (feedback.status !== 'PENDING') {
                void vscode.window.showWarningMessage(
                    'The agent already has this one. Reply to it instead of rewriting the note.',
                );
                return;
            }
            const note = await askForNote('e.g. this loop reallocates on every pass', {
                value: feedback.note,
                title: 'Edit Pin',
            });
            if (!note) {
                return;
            }
            // Refused, with a note that is not blank, means the item stopped being pending while
            // the box was open. Say so: the developer typed those words and should know.
            if (!queue.updateNote(feedback.id, note)) {
                void vscode.window.showWarningMessage(
                    'The agent picked this item up while you were editing. Your change was not saved.',
                );
            }
        }),

        vscode.commands.registerCommand('pinboard.deleteItem', (id?: string) => {
            const target = id ?? tree.selected;
            if (target) {
                queue.remove([target]);
            }
        }),

        vscode.commands.registerCommand('pinboard.clearResolved', () => {
            const removed = queue.removeByStatus(['RESOLVED', 'DISMISSED']);
            void vscode.window.showInformationMessage(
                removed === 0 ? 'Nothing finished to clear.' : `Cleared ${removed} finished item(s).`,
            );
        }),

        vscode.commands.registerCommand('pinboard.deleteAll', async () => {
            const total = queue.all().length;
            if (total === 0) {
                return;
            }
            // Confirmed because it cannot be undone and takes pending work with it.
            const answer = await vscode.window.showWarningMessage(
                `Delete all ${total} item(s), including anything still pending?`,
                { modal: true },
                'Delete All',
            );
            if (answer === 'Delete All') {
                queue.removeAll();
            }
        }),

        // Recomputes staleness rather than only repainting: the reason to press Refresh is that
        // something changed on disk outside the editor, which is exactly what the cached flags miss.
        vscode.commands.registerCommand('pinboard.refresh', () => void refresh()),

        vscode.commands.registerCommand('pinboard.copyMcpConfig', async () => {
            if (!server) {
                void vscode.window.showWarningMessage(
                    'Pinboard\'s MCP server is not running. Check the Pinboard output channel.',
                );
                return;
            }
            const config = JSON.stringify(
                { mcpServers: { pinboard: { type: 'http', url: server.url } } },
                null,
                2,
            );
            await vscode.env.clipboard.writeText(config);
            output.appendLine(`Config copied for ${server.url}`);
            void vscode.window.showInformationMessage(
                'MCP config copied. Paste it into your agent, and note the port changes when VS Code restarts unless you pin pinboard.mcpServer.port.',
            );
        }),
    );
}
