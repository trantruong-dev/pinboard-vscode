/**
 * The MCP server itself, over Streamable HTTP on the loopback interface.
 *
 * This is the part JetBrains does not need. Its IDE ships an MCP server and a plugin simply adds
 * tools to it; VS Code is an MCP *client*, so a server has to exist somewhere. Running it inside
 * the extension host - rather than as a child process - is what lets the tools read and write the
 * live queue directly, which is what `feedback_watch` needs to block on.
 *
 * Any MCP client can attach, not only the editor's own agent, which keeps the story the same as the
 * JetBrains version: one queue, whichever agent you use.
 *
 * Security posture: bound to 127.0.0.1 so nothing off the machine can reach it, and the transport
 * validates the Host header so a web page cannot rebind DNS and talk to it through the browser. The
 * queue holds verbatim source code, so both matter.
 */

import { randomUUID } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { FeedbackTools, registerFeedbackTools } from './feedback-tools';

const HOST = '127.0.0.1';
const ENDPOINT = '/mcp';

/** Host headers the transport will answer to. Anything else is a rebinding attempt. */
function allowedHosts(port: number): string[] {
    return [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost'];
}

export interface RunningMcpServer {
    readonly port: number;
    readonly url: string;
    dispose(): Promise<void>;
}

/**
 * Starts the server and resolves once it is actually listening.
 *
 * `requestedPort` of 0 lets the operating system pick, which is right when the editor is told the
 * address directly. A fixed port only matters when someone writes a client config by hand.
 */
export async function startMcpServer(
    tools: FeedbackTools,
    requestedPort: number,
    log: (message: string) => void,
): Promise<RunningMcpServer> {
    const mcp = new McpServer(
        { name: 'pinboard', version: '0.0.1' },
        {
            instructions:
                'Pinboard holds code feedback the developer pinned in their editor. Use feedback_watch to pick up a batch, acknowledge it, then close each item with feedback_resolve and a real summary.',
        },
    );
    registerFeedbackTools(mcp, tools);

    // One transport per session, kept so follow-up requests reach the session that started them.
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const http = createServer((req, res) => {
        void handle(req, res).catch(error => {
            log(`request failed: ${String(error)}`);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        });
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const path = (req.url ?? '').split('?')[0];
        if (path !== ENDPOINT) {
            res.writeHead(404).end();
            return;
        }

        const sessionId = req.headers['mcp-session-id'];
        const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
        if (existing) {
            await existing.handleRequest(req, res);
            return;
        }

        // No session yet: this must be an initialize, which gets a transport of its own.
        const port = (http.address() as AddressInfo).port;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: allowedHosts(port),
            onsessioninitialized: id => {
                sessions.set(id, transport);
                log(`session ${id} opened`);
            },
            onsessionclosed: id => {
                sessions.delete(id);
                log(`session ${id} closed`);
            },
        });
        transport.onclose = () => {
            if (transport.sessionId) {
                sessions.delete(transport.sessionId);
            }
        };
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
    }

    const port = await listen(http, requestedPort);
    log(`listening on http://${HOST}:${port}${ENDPOINT}`);

    return {
        port,
        url: `http://${HOST}:${port}${ENDPOINT}`,
        async dispose() {
            for (const transport of sessions.values()) {
                await transport.close().catch(() => undefined);
            }
            sessions.clear();
            await mcp.close().catch(() => undefined);
            await new Promise<void>(resolve => http.close(() => resolve()));
        },
    };
}

function listen(http: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, HOST, () => {
            http.removeListener('error', reject);
            resolve((http.address() as AddressInfo).port);
        });
    });
}
