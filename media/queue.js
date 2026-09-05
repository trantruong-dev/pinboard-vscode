/*
 * The queue panel's renderer.
 *
 * It owns no state of its own beyond the last message: the extension decides what the panel says
 * and posts it whole, and this file turns that into DOM. Keeping the decisions on the extension
 * side is what lets them be tested without a browser.
 *
 * Everything user-written - notes, code, agent replies - reaches the DOM through textContent, never
 * innerHTML. The store keeps that text verbatim, so the display layer is where it becomes safe to
 * render, and pinning the top of an HTML file must show the code rather than run it.
 */

// @ts-check
(function () {
    const vscode = acquireVsCodeApi();

    const ribbon = document.getElementById('ribbon');
    const bar = document.getElementById('bar');
    const legend = document.getElementById('legend');
    const queue = document.getElementById('queue');
    const detail = document.getElementById('detail');
    const footer = document.getElementById('footer');

    /** @param {string} tag @param {string} [className] @param {string} [text] */
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function post(type, payload) {
        vscode.postMessage(Object.assign({ type }, payload));
    }

    // ---------- ribbon ----------

    function renderRibbon(state) {
        ribbon.hidden = state.total === 0;
        if (state.total === 0) {
            return;
        }
        bar.replaceChildren();
        legend.replaceChildren();
        const total = state.ribbon.reduce((sum, segment) => sum + segment.count, 0);
        for (const segment of state.ribbon) {
            if (segment.count > 0 && total > 0) {
                const fill = el('span', 'tone-' + segment.tone);
                fill.style.width = (segment.count / total) * 100 + '%';
                fill.style.background = 'var(--tone)';
                bar.append(fill);
            }
            legend.append(el('span', 'tone-' + segment.tone, '● ' + segment.count + ' ' + segment.label));
        }
    }

    // ---------- queue ----------

    function renderQueue(state) {
        queue.replaceChildren();
        if (state.total === 0) {
            queue.append(emptyState());
            return;
        }
        for (const group of state.groups) {
            queue.append(groupHeader(group, state.collapsed.includes(group.status)));
            for (const card of group.cards) {
                queue.append(cardNode(card, card.id === state.selectedId));
            }
        }
    }

    function emptyState() {
        const node = el('div', 'empty');
        node.append('Nothing pinned yet.');
        node.append(el('br'), el('br'));
        node.append('Select some code and press ');
        node.append(el('kbd', undefined, navigator.platform.startsWith('Mac') ? '⌘⌥⇧F' : 'Ctrl+Alt+Shift+F'));
        node.append(', or right-click and choose Pin for Agent.');
        node.append(el('br'), el('br'));
        const link = el('a', undefined, 'Copy MCP config for another agent');
        link.tabIndex = 0;
        link.addEventListener('click', () => post('copyMcpConfig'));
        node.append(link);
        return node;
    }

    function groupHeader(group, collapsed) {
        const node = el('div', 'group-header');
        node.setAttribute('role', 'button');
        node.tabIndex = 0;
        node.setAttribute('aria-expanded', String(!collapsed));
        node.append(el('span', 'twisty', collapsed ? '▸' : '▾'));
        node.append(el('span', 'label', group.label));
        node.append(el('span', 'count', String(group.count)));
        const toggle = () => post('toggleGroup', { status: group.status });
        node.addEventListener('click', toggle);
        node.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });
        return node;
    }

    function cardNode(card, selected) {
        const node = el('button', 'card tone-' + card.tone + (selected ? ' selected' : ''));
        node.type = 'button';
        node.title = card.tooltip;

        if (card.location || card.warning) {
            const meta = el('div', 'meta');
            if (card.location) {
                meta.append(el('span', undefined, card.location));
            }
            if (card.warning) {
                meta.append(el('span', 'warning', card.warning));
            }
            node.append(meta);
        }

        node.append(el('div', 'note', card.note));
        if (card.snippet) {
            node.append(el('div', 'snippet', card.snippet));
        }
        node.append(el('div', 'age', card.age));

        node.addEventListener('click', () => post('select', { id: card.id }));
        node.addEventListener('dblclick', () => post('reveal', { id: card.id }));
        node.addEventListener('contextmenu', () => post('select', { id: card.id }));
        return node;
    }

    // ---------- detail ----------

    function renderDetail(state) {
        detail.hidden = state.detail === null;
        detail.replaceChildren();
        if (!state.detail) {
            return;
        }
        const view = state.detail;

        const head = el('div', 'head');
        head.append(el('span', 'path', view.location));

        const remove = el('button', 'close', '🗑');
        remove.type = 'button';
        remove.title = 'Delete this item';
        remove.addEventListener('click', () => post('delete', { id: view.id }));
        head.append(remove);

        const close = el('button', 'close', '✕');
        close.type = 'button';
        close.title = 'Close detail';
        close.addEventListener('click', () => post('select', { id: null }));
        head.append(close);
        detail.append(head);

        const status = el('div');
        status.append(el('span', 'pill tone-' + view.tone, view.status));
        status.append(el('span', 'when', ' ' + view.age));
        detail.append(status);

        if (view.banner) {
            detail.append(el('div', 'banner', view.banner));
        }

        detail.append(el('h4', undefined, 'Feedback'));
        detail.append(el('div', 'body', view.note));

        if (view.code) {
            detail.append(el('h4', undefined, 'Code at capture time'));
            const pre = el('pre');
            pre.append(el('code', undefined, view.code));
            detail.append(pre);
            const hints = [];
            if (view.truncated) {
                hints.push('Snapshot truncated');
            }
            if (view.symbolPath) {
                hints.push(view.symbolPath);
            }
            if (hints.length > 0) {
                detail.append(el('div', 'note-hint', hints.join(' · ')));
            }
        }

        if (view.thread.length > 0) {
            detail.append(el('h4', undefined, 'Conversation'));
            for (const message of view.thread) {
                const block = el('div', 'message');
                const line = el('div');
                line.append(el('span', 'who', message.who));
                line.append(el('span', 'when', message.age));
                block.append(line);
                block.append(el('div', 'body', message.body));
                detail.append(block);
            }
        }
    }

    // ---------- footer ----------

    function renderFooter(state) {
        footer.className = 'tone-' + state.connection.tone;
        footer.replaceChildren();
        footer.append(el('span', 'dot'));
        footer.append(el('span', 'label', state.connection.label));
        const text = el('span', 'detail', state.connection.detail);
        text.title = state.connection.detail;
        footer.append(text);
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || message.type !== 'state') {
            return;
        }
        const state = message.state;
        renderRibbon(state);
        renderQueue(state);
        renderDetail(state);
        renderFooter(state);
    });

    post('ready');
})();
