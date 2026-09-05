/**
 * Keeps a pin on its code while the file above it is edited.
 *
 * JetBrains hands a plugin a RangeMarker that the platform maintains. VS Code has no such thing for
 * ranges that must outlive a document, so the arithmetic lives here: given the line ranges that were
 * replaced and what replaced them, work out where a pin ends up.
 *
 * Pure and editor-free, which is the point - this is the part most likely to be subtly wrong, and it
 * can be tested exhaustively without an editor.
 */

/** One edit, in the terms this module needs: which lines went, and how many arrived. */
export interface LineEdit {
    /** First line replaced, 1-based inclusive. */
    startLine: number;
    /** Last line replaced, 1-based inclusive. Equal to startLine for an insertion within a line. */
    endLine: number;
    /** How many lines the replacement text occupies. */
    newLineCount: number;
}

/** A pin's position, 1-based and inclusive. */
export interface LineRange {
    startLine: number;
    endLine: number;
}

/**
 * Where [range] ends up after [edit].
 *
 * Returns null when the edit overlaps the pinned lines themselves. That is not a position problem
 * but a content problem: the pinned code was rewritten, so the honest answer is to leave the range
 * alone and let staleness report it, rather than to invent a plausible new location.
 */
export function shiftRange(range: LineRange, edit: LineEdit): LineRange | null {
    const removed = edit.endLine - edit.startLine + 1;
    const delta = edit.newLineCount - removed;

    // Entirely below the pin: nothing above moved, so the pin has not.
    if (edit.startLine > range.endLine) {
        return range;
    }
    // Entirely above the pin: the whole pin slides by the number of lines gained or lost.
    if (edit.endLine < range.startLine) {
        return delta === 0
            ? range
            : { startLine: range.startLine + delta, endLine: range.endLine + delta };
    }
    // Anything else touches the pinned lines.
    return null;
}

/**
 * Applies a batch of edits to one range.
 *
 * Edits are applied from the bottom of the file upwards so that each one is measured against
 * positions that later edits have not yet disturbed. Returns null as soon as any edit lands on the
 * pinned code.
 */
export function shiftRangeAll(range: LineRange, edits: LineEdit[]): LineRange | null {
    const ordered = [...edits].sort((a, b) => b.startLine - a.startLine);
    let current: LineRange | null = range;
    for (const edit of ordered) {
        if (current === null) {
            return null;
        }
        current = shiftRange(current, edit);
    }
    return current;
}
