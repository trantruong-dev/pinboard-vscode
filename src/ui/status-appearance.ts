/**
 * The single mapping from an item's state to how it looks. The card, the progress ribbon and the
 * editor decorations all read it, so a status cannot mean amber in one place and green in another.
 *
 * Tones are names, not colours: the webview resolves each to a VS Code theme variable, and the
 * decorations resolve the same names to `ThemeColor`s. Naming a hex on either side would be the one
 * thing that lets the two drift.
 */

import { Status, isOpen } from '../model/feedback';
import { StaleFlags } from '../capture/staleness';

export type Tone = 'pending' | 'active' | 'done';

export function toneOf(status: Status): Tone {
    switch (status) {
        case 'PENDING':
            return 'pending';
        case 'ACKNOWLEDGED':
            return 'active';
        case 'RESOLVED':
        case 'DISMISSED':
            return 'done';
    }
}

/**
 * A short warning to show beside the location, or null.
 *
 * Only open items warn. A resolved item pointing at code that has since changed is the expected
 * outcome of the agent doing the work - flagging it would make every finished item look broken.
 */
export function warningFor(status: Status, flags: StaleFlags): string | null {
    if (!isOpen(status)) {
        return null;
    }
    if (flags.fileMissing) {
        return 'file missing';
    }
    if (flags.stale) {
        return 'stale';
    }
    return null;
}
