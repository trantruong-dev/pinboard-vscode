/**
 * Whether the code under a pin still reads the way it did.
 *
 * Pure functions over strings: no editor, no file system. Everything here is decided by comparing a
 * hash of the snapshot with a hash of what is there now.
 */

import { createHash } from 'node:crypto';

import { Feedback } from '../model/feedback';

/** What the queue shows next to an item, and what an agent is told about it. */
export interface StaleFlags {
    /** The pinned code changed after it was pinned. Line numbers can no longer be trusted. */
    stale: boolean;
    /** The file is gone entirely: renamed, moved, or deleted. */
    fileMissing: boolean;
}

export const NOT_STALE: StaleFlags = { stale: false, fileMissing: false };

export function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Pulls the pinned line range back out of a document.
 *
 * Lines are 1-based and inclusive, the way an editor numbers them. Out-of-range values return null
 * rather than a clamped guess, because a truncated comparison would report code as unchanged when
 * the file has simply grown shorter.
 */
export function linesOf(text: string, startLine: number, endLine: number): string | null {
    if (startLine < 1 || endLine < startLine) {
        return null;
    }
    const lines = text.split('\n');
    if (endLine > lines.length) {
        return null;
    }
    return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * Compares a snapshot with the current text.
 *
 * Trailing whitespace on the final line is ignored: an editor that trims on save, or a file that
 * gained a newline at the end, has not changed the code the developer pointed at.
 */
export function hasDrifted(snapshot: string, current: string): boolean {
    return sha256(snapshot.trimEnd()) !== sha256(current.trimEnd());
}

/**
 * Works out the flags for one item.
 *
 * `currentText` is the file's content now, or null when the file could not be read at all. An item
 * with nothing to compare against - no snapshot, or no line range - is reported as fresh: saying
 * "stale" would imply a comparison that never happened.
 */
export function flagsFor(feedback: Feedback, currentText: string | null): StaleFlags {
    if (feedback.scope === 'PROJECT' || !feedback.filePath) {
        return NOT_STALE;
    }
    if (currentText === null) {
        return { stale: true, fileMissing: true };
    }
    if (!feedback.codeSnapshot || feedback.startLine === null || feedback.endLine === null) {
        return NOT_STALE;
    }
    const current = linesOf(currentText, feedback.startLine, feedback.endLine);
    if (current === null) {
        // The range now runs off the end of the file, so the code cannot still be there.
        return { stale: true, fileMissing: false };
    }
    return { stale: hasDrifted(feedback.codeSnapshot, current), fileMissing: false };
}
