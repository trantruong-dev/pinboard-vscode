/**
 * Turning what is on screen into a stored pin.
 *
 * The snapshot taken here is the thing that makes a pin survive the file changing underneath it, so
 * it is captured at pin time and never refreshed.
 */

import * as vscode from 'vscode';

import { Feedback } from '../model/feedback';
import { sha256 } from './staleness';

export type Draft = Omit<Feedback, 'id' | 'status' | 'thread' | 'createdAt' | 'updatedAt'>;

/** Workspace-relative path with forward slashes, or null for a file outside any folder. */
export function relativePath(uri: vscode.Uri): string | null {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return null;
    }
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

/**
 * Names the symbol a range sits inside, e.g. `Calculator#add`.
 *
 * This is what lets an agent relocate a snapshot after the line numbers stop being true, so it is
 * worth asking the language server for. Any failure is swallowed: a missing symbol makes a pin
 * slightly less useful, never unusable.
 */
export async function symbolPathAt(
    document: vscode.TextDocument,
    range: vscode.Range,
): Promise<string | null> {
    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri,
        );
        if (!symbols?.length) {
            return null;
        }
        const trail: string[] = [];
        let level: vscode.DocumentSymbol[] | undefined = symbols;
        while (level) {
            const hit: vscode.DocumentSymbol | undefined = level.find(symbol =>
                symbol.range.contains(range),
            );
            if (!hit) {
                break;
            }
            trail.push(hit.name);
            level = hit.children?.length ? hit.children : undefined;
        }
        return trail.length > 0 ? trail.join('#') : null;
    } catch {
        return null;
    }
}

/** Trims a snapshot to a sane size and says whether it had to. */
export function clampSnapshot(text: string, maxLines: number): { text: string; truncated: boolean } {
    const lines = text.split('\n');
    if (lines.length <= maxLines) {
        return { text, truncated: false };
    }
    return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

/** Builds the draft for a selected range. Lines come out 1-based and inclusive. */
export async function draftFromSelection(
    editor: vscode.TextEditor,
    note: string,
    maxLines: number,
    vcsRevision: string | null,
): Promise<Draft | null> {
    const path = relativePath(editor.document.uri);
    if (path === null) {
        return null;
    }
    const selection = editor.selection;
    const range = selection.isEmpty
        ? editor.document.lineAt(selection.start.line).range
        : new vscode.Range(selection.start, selection.end);

    const raw = editor.document.getText(
        new vscode.Range(
            range.start.line,
            0,
            range.end.line,
            editor.document.lineAt(range.end.line).text.length,
        ),
    );
    const snapshot = clampSnapshot(raw, maxLines);

    return {
        scope: 'SELECTION',
        note,
        filePath: path,
        language: editor.document.languageId,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        codeSnapshot: snapshot.text,
        contentSha256: sha256(snapshot.text),
        truncated: snapshot.truncated,
        symbolPath: await symbolPathAt(editor.document, range),
        vcsRevision,
    };
}

/**
 * Builds the draft for a whole file.
 *
 * No snapshot on purpose. A note about a file as a whole is not about particular lines, and copying
 * the entire file into the queue would bloat it for nothing.
 */
export function draftFromFile(uri: vscode.Uri, note: string, vcsRevision: string | null): Draft | null {
    const path = relativePath(uri);
    if (path === null) {
        return null;
    }
    return {
        scope: 'FILE',
        note,
        filePath: path,
        language: null,
        startLine: null,
        endLine: null,
        codeSnapshot: null,
        contentSha256: null,
        truncated: false,
        symbolPath: null,
        vcsRevision,
    };
}
