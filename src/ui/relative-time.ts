/**
 * Short age for a past timestamp, e.g. `2m ago`.
 *
 * Deliberately coarse: the panel shows when something last happened, not how long ago to the second,
 * and a coarse label stops the footer from repainting on every timer tick.
 *
 * A timestamp in the future (clock skew, a store file copied between machines) reads as `just now`
 * rather than a negative age.
 */
export function relativeTime(timestampMs: number, nowMs: number = Date.now()): string {
    const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
    if (seconds < 5) {
        return 'just now';
    }
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    if (seconds < 3_600) {
        return `${Math.floor(seconds / 60)}m ago`;
    }
    if (seconds < 86_400) {
        return `${Math.floor(seconds / 3_600)}h ago`;
    }
    return `${Math.floor(seconds / 86_400)}d ago`;
}
