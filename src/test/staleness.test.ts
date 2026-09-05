import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Feedback } from '../model/feedback';
import { flagsFor, hasDrifted, linesOf, sha256 } from '../capture/staleness';

const FILE = ['zero', 'one', 'two', 'three', 'four'].join('\n');

function pin(overrides: Partial<Feedback> = {}): Feedback {
    return {
        id: 'id',
        status: 'PENDING',
        scope: 'SELECTION',
        note: 'a note',
        filePath: 'src/thing.ts',
        language: 'typescript',
        startLine: 2,
        endLine: 3,
        codeSnapshot: 'one\ntwo',
        contentSha256: sha256('one\ntwo'),
        truncated: false,
        symbolPath: null,
        vcsRevision: null,
        thread: [],
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

test('lines are 1-based and inclusive, the way the editor numbers them', () => {
    assert.equal(linesOf(FILE, 1, 1), 'zero');
    assert.equal(linesOf(FILE, 2, 3), 'one\ntwo');
    assert.equal(linesOf(FILE, 5, 5), 'four');
});

/**
 * A range running off the end must not come back clamped. A shorter slice could hash equal to the
 * snapshot and report changed code as untouched.
 */
test('a range past the end of the file returns nothing rather than a short slice', () => {
    assert.equal(linesOf(FILE, 4, 9), null);
    assert.equal(linesOf(FILE, 0, 2), null);
    assert.equal(linesOf(FILE, 3, 2), null);
});

test('unchanged code is not stale', () => {
    assert.deepEqual(flagsFor(pin(), FILE), { stale: false, fileMissing: false });
});

test('changed code at the pinned lines is stale', () => {
    const edited = ['zero', 'one', 'TWO', 'three', 'four'].join('\n');
    assert.deepEqual(flagsFor(pin(), edited), { stale: true, fileMissing: false });
});

/** The pin moved with the code, so the same text at new lines must read as fresh. */
test('code that moved but did not change is not stale once the pin followed it', () => {
    const shifted = ['header', 'zero', 'one', 'two', 'three'].join('\n');
    assert.deepEqual(flagsFor(pin({ startLine: 3, endLine: 4 }), shifted), {
        stale: false,
        fileMissing: false,
    });
});

test('a missing file is reported as missing and stale together', () => {
    assert.deepEqual(flagsFor(pin(), null), { stale: true, fileMissing: true });
});

test('a file that shrank under the pin is stale, not missing', () => {
    assert.deepEqual(flagsFor(pin({ startLine: 4, endLine: 5 }), 'only\ntwo\nlines'), {
        stale: true,
        fileMissing: false,
    });
});

/** Nothing was compared, so claiming staleness would be a lie. */
test('an item with no snapshot is never called stale', () => {
    assert.deepEqual(flagsFor(pin({ codeSnapshot: null }), FILE), {
        stale: false,
        fileMissing: false,
    });
    assert.deepEqual(flagsFor(pin({ scope: 'FILE', startLine: null, endLine: null }), FILE), {
        stale: false,
        fileMissing: false,
    });
});

test('a project-scoped note has no file and is never stale', () => {
    assert.deepEqual(flagsFor(pin({ scope: 'PROJECT', filePath: null }), null), {
        stale: false,
        fileMissing: false,
    });
});

/** An editor that trims on save has not changed the code the developer pointed at. */
test('trailing whitespace on the last line does not count as drift', () => {
    assert.equal(hasDrifted('one\ntwo', 'one\ntwo  \n'), false);
    assert.equal(hasDrifted('one\ntwo', 'one\n two'), true);
});
