/**
 * Where a workspace's queue is written.
 *
 * One file per workspace, named from a hash of its path and kept in the extension's own storage
 * rather than in the repository, so a queue can never land in a commit. The file holds verbatim
 * source code, which is exactly why it belongs outside the tree.
 */

import { createHash } from 'node:crypto';

/**
 * Normalises a workspace path so the same project keeps its queue across sessions.
 *
 * Backslashes and a trailing separator are cosmetic and must not produce a second queue. Case is
 * deliberately left alone: paths are case-sensitive on Linux, and folding it would merge two
 * genuinely different projects into one.
 */
export function normaliseWorkspacePath(path: string): string {
    const forward = path.replace(/\\/g, '/');
    return forward.length > 1 ? forward.replace(/\/+$/, '') : forward;
}

/** File name for a workspace's queue. Short enough to read, wide enough not to collide. */
export function storeFileName(workspacePath: string): string {
    const normalised = normaliseWorkspacePath(workspacePath);
    const digest = createHash('sha256').update(normalised, 'utf8').digest('hex');
    return `${digest.slice(0, 16)}.json`;
}
