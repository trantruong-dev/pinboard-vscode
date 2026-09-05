import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LineEdit, shiftRange, shiftRangeAll } from '../capture/anchors';

const pin = { startLine: 10, endLine: 12 };

/** Adding lines above a pin has to move the pin, or it points at the wrong code afterwards. */
test('an insertion above the pin moves it down by the lines gained', () => {
    const edit: LineEdit = { startLine: 3, endLine: 3, newLineCount: 4 };
    assert.deepEqual(shiftRange(pin, edit), { startLine: 13, endLine: 15 });
});

test('a deletion above the pin moves it up by the lines lost', () => {
    const edit: LineEdit = { startLine: 2, endLine: 5, newLineCount: 1 };
    assert.deepEqual(shiftRange(pin, edit), { startLine: 7, endLine: 9 });
});

test('an edit above that adds and removes the same number of lines moves nothing', () => {
    const edit: LineEdit = { startLine: 2, endLine: 4, newLineCount: 3 };
    assert.deepEqual(shiftRange(pin, edit), pin);
});

test('an edit below the pin leaves it alone', () => {
    const edit: LineEdit = { startLine: 20, endLine: 25, newLineCount: 1 };
    assert.deepEqual(shiftRange(pin, edit), pin);
});

/**
 * The pinned lines themselves changing is a content problem, not a position one. Refusing to
 * produce a new range is what lets staleness report it honestly instead of silently relocating the
 * pin onto code the developer never looked at.
 */
test('an edit that touches the pinned lines refuses to guess a new position', () => {
    assert.equal(shiftRange(pin, { startLine: 11, endLine: 11, newLineCount: 1 }), null);
    assert.equal(shiftRange(pin, { startLine: 1, endLine: 10, newLineCount: 2 }), null);
    assert.equal(shiftRange(pin, { startLine: 12, endLine: 40, newLineCount: 2 }), null);
    assert.equal(shiftRange(pin, { startLine: 1, endLine: 99, newLineCount: 1 }), null);
});

test('an edit ending on the line directly above is still above', () => {
    const edit: LineEdit = { startLine: 8, endLine: 9, newLineCount: 4 };
    assert.deepEqual(shiftRange(pin, edit), { startLine: 12, endLine: 14 });
});

test('an edit starting on the line directly below is still below', () => {
    assert.deepEqual(shiftRange(pin, { startLine: 13, endLine: 14, newLineCount: 9 }), pin);
});

/**
 * A single keystroke can produce several changes, and they are reported against positions before
 * any of them applied. Applying them bottom-up is what keeps each one measured correctly.
 */
test('several edits above the pin accumulate', () => {
    const edits: LineEdit[] = [
        { startLine: 1, endLine: 1, newLineCount: 3 },
        { startLine: 5, endLine: 5, newLineCount: 2 },
    ];
    assert.deepEqual(shiftRangeAll(pin, edits), { startLine: 13, endLine: 15 });
});

test('a batch where any edit touches the pin refuses the whole batch', () => {
    const edits: LineEdit[] = [
        { startLine: 1, endLine: 1, newLineCount: 3 },
        { startLine: 11, endLine: 11, newLineCount: 1 },
    ];
    assert.equal(shiftRangeAll(pin, edits), null);
});

test('an empty batch changes nothing', () => {
    assert.deepEqual(shiftRangeAll(pin, []), pin);
});

/** A pin on line 1 is the boundary most likely to go negative. */
test('a pin at the top of the file survives a deletion that starts at the top', () => {
    const top = { startLine: 1, endLine: 2 };
    assert.equal(shiftRange(top, { startLine: 1, endLine: 1, newLineCount: 1 }), null);
});
