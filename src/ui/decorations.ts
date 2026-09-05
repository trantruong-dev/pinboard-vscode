/**
 * Marks pinned ranges in the editor, so a pin is visible where the code is rather than only in a
 * panel the developer has to remember to open.
 *
 * Colours come from the theme, never from literals: a hard-coded tint that reads well on a dark
 * theme is unreadable on a light one.
 */

import * as vscode from 'vscode';

import { Feedback } from '../model/feedback';
import { FeedbackStore } from '../store/feedback-store';
import { StaleFlags } from '../capture/staleness';
import { relativePath } from '../capture/capture';

export class PinDecorations implements vscode.Disposable {
    private readonly open: vscode.TextEditorDecorationType;
    private readonly drifted: vscode.TextEditorDecorationType;

    constructor(private readonly store: FeedbackStore) {
        this.open = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
            overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            isWholeLine: true,
        });
        this.drifted = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('inputValidation.warningBackground'),
            overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            isWholeLine: true,
        });
    }

    /** Repaints every visible editor. Cheap enough to do on any queue change. */
    refresh(flags: Map<string, StaleFlags>): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.apply(editor, flags);
        }
    }

    private apply(editor: vscode.TextEditor, flags: Map<string, StaleFlags>): void {
        const path = relativePath(editor.document.uri);
        if (path === null) {
            editor.setDecorations(this.open, []);
            editor.setDecorations(this.drifted, []);
            return;
        }

        const openRanges: vscode.DecorationOptions[] = [];
        const driftedRanges: vscode.DecorationOptions[] = [];
        for (const feedback of this.store.all()) {
            if (feedback.filePath !== path || feedback.status === 'RESOLVED' || feedback.status === 'DISMISSED') {
                continue;
            }
            const range = rangeOf(feedback, editor.document);
            if (!range) {
                continue;
            }
            const option: vscode.DecorationOptions = {
                range,
                hoverMessage: new vscode.MarkdownString(feedback.note.trim()),
            };
            (flags.get(feedback.id)?.stale ? driftedRanges : openRanges).push(option);
        }
        editor.setDecorations(this.open, openRanges);
        editor.setDecorations(this.drifted, driftedRanges);
    }

    dispose(): void {
        this.open.dispose();
        this.drifted.dispose();
    }
}

/** Converts a stored 1-based inclusive range into a document range, clamped to what exists. */
export function rangeOf(feedback: Feedback, document: vscode.TextDocument): vscode.Range | null {
    if (feedback.startLine === null) {
        return null;
    }
    const start = feedback.startLine - 1;
    if (start < 0 || start >= document.lineCount) {
        return null;
    }
    const end = Math.min((feedback.endLine ?? feedback.startLine) - 1, document.lineCount - 1);
    return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
}
