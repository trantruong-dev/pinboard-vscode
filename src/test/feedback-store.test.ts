import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FeedbackStore } from '../store/feedback-store';
import { normaliseWorkspacePath, storeFileName } from '../store/store-paths';

async function freshStore(): Promise<{ store: FeedbackStore; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'pinboard-'));
    const file = join(dir, 'queue.json');
    const store = new FeedbackStore(file);
    await store.load();
    return { store, file };
}

function draft(note: string) {
    return {
        scope: 'SELECTION' as const,
        note,
        filePath: 'src/thing.ts',
        language: 'typescript',
        startLine: 10,
        endLine: 12,
        codeSnapshot: 'code',
        contentSha256: 'sha',
        truncated: false,
        symbolPath: null,
        vcsRevision: null,
    };
}

test('a pin starts pending with a generated id', async () => {
    const { store } = await freshStore();
    const first = store.add(draft('one'));
    const second = store.add(draft('two'));
    assert.equal(first.status, 'PENDING');
    assert.notEqual(first.id, second.id);
    assert.equal(store.all().length, 2);
});

test('the queue survives being written and read back', async () => {
    const { store, file } = await freshStore();
    store.add(draft('remember me'));
    await store.flush();

    const reopened = new FeedbackStore(file);
    await reopened.load();
    assert.equal(reopened.all().length, 1);
    assert.equal(reopened.all()[0].note, 'remember me');
});

/** A corrupt file must not stop the extension loading; the queue simply starts empty. */
test('an unreadable file loads as an empty queue instead of throwing', async () => {
    const { file } = await freshStore();
    await writeFile(file, 'not json at all', 'utf8');
    const store = new FeedbackStore(file);
    await store.load();
    assert.deepEqual(store.all(), []);
});

test('the file is replaced atomically, so no temporary file is left behind', async () => {
    const { store, file } = await freshStore();
    store.add(draft('one'));
    await store.flush();
    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(written.version, 1);
    assert.equal(written.items.length, 1);
    await assert.rejects(() => readFile(`${file}.tmp`, 'utf8'));
});

test('setStatus reports only the ids that existed', async () => {
    const { store } = await freshStore();
    const item = store.add(draft('one'));
    const touched = store.setStatus([item.id, 'not-a-real-id'], 'ACKNOWLEDGED');
    assert.equal(touched.length, 1);
    assert.equal(store.find(item.id)?.status, 'ACKNOWLEDGED');
});

test('a thread message leaves the status alone', async () => {
    const { store } = await freshStore();
    const item = store.add(draft('one'));
    store.appendMessage(item.id, { author: 'AGENT', body: 'a question', createdAt: 1 });
    const updated = store.find(item.id)!;
    assert.equal(updated.status, 'PENDING');
    assert.equal(updated.thread.length, 1);
});

test('clearing finished work never touches anything still open', async () => {
    const { store } = await freshStore();
    const pending = store.add(draft('pending'));
    const done = store.add(draft('done'));
    const declined = store.add(draft('declined'));
    store.setStatus([done.id], 'RESOLVED');
    store.setStatus([declined.id], 'DISMISSED');

    assert.equal(store.removeByStatus(['RESOLVED', 'DISMISSED']), 2);
    assert.equal(store.all().length, 1);
    assert.equal(store.all()[0].id, pending.id);
});

/**
 * A line shift is not something the developer did. Bumping updatedAt would reorder the queue under
 * them while they type.
 */
test('moving a pin does not bump its updatedAt', async () => {
    const { store } = await freshStore();
    const item = store.add(draft('one'));
    const before = store.find(item.id)!.updatedAt;

    const moved = store.updateLocations(new Map([[item.id, { startLine: 20, endLine: 22 }]]));
    const after = store.find(item.id)!;
    assert.equal(moved, 1);
    assert.equal(after.startLine, 20);
    assert.equal(after.updatedAt, before);
});

test('moving a pin to where it already is writes nothing', async () => {
    const { store } = await freshStore();
    const item = store.add(draft('one'));
    assert.equal(store.updateLocations(new Map([[item.id, { startLine: 10, endLine: 12 }]])), 0);
});

test('listeners hear about a change', async () => {
    const { store } = await freshStore();
    let heard = 0;
    const stop = store.onChanged(() => heard++);
    store.add(draft('one'));
    assert.equal(heard, 1);
    stop();
    store.add(draft('two'));
    assert.equal(heard, 1);
});

test('hasOpenItemFor sees pending work and ignores finished work', async () => {
    const { store } = await freshStore();
    const item = store.add(draft('one'));
    assert.equal(store.hasOpenItemFor('src/thing.ts'), true);
    store.setStatus([item.id], 'RESOLVED');
    assert.equal(store.hasOpenItemFor('src/thing.ts'), false);
});

/** Cosmetic path differences must not produce a second queue for one project. */
test('a workspace path keeps its queue across slash and trailing-separator differences', () => {
    const a = storeFileName('C:\\Users\\dev\\project');
    const b = storeFileName('C:/Users/dev/project/');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}\.json$/);
});

/** Paths are case-sensitive on Linux; folding case would merge two different projects. */
test('case is left alone, so two differently cased paths stay separate', () => {
    assert.notEqual(storeFileName('/home/dev/Project'), storeFileName('/home/dev/project'));
});

test('normalising leaves a root path alone', () => {
    assert.equal(normaliseWorkspacePath('/'), '/');
});
