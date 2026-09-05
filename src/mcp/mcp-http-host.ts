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

import { FeedbackTools, McpActivity, registerFeedbackTools } from './feedback-tools';

const HOST = '127.0.0.1';
const ENDPOINT = '/mcp';

/** Host headers the transport will answer to. Anything else is a rebinding attempt. */
function allowedHosts(port: number): string[] {
    return [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost'];
}

/**
 * What the panel can say about the connection, and only what is observed.
 *
 * Sessions are counted rather than guessed at because this build hosts the server: a session here
 * is a client that completed an MCP handshake, not an inference from something else.
 */
export interface McpObservations {
    sessions: number;
    lastToolCallAt: number | null;
    lastToolName: string | null;
}

export interface RunningMcpServer {
    readonly port: number;
    readonly url: string;
    observe(): McpObservations;
    /** Called whenever a session opens or closes or a tool is used, so the panel can repaint. */
    onActivity(listener: () => void): void;
    dispose(): Promise<void>;
}

/** An open MCP session: the client's transport and the server instance bound to it. */
interface Session {
    transport: StreamableHTTPServerTransport;
    mcp: McpServer;
}

/**
 * Builds a server for one session.
 *
 * A server instance binds to exactly one transport - the SDK refuses a second with "Already
 * connected to a transport" - so sharing one across sessions locks out every client after the
 * first. They all close over the same FeedbackTools, so a session per client still means one queue.
 */
function createMcpServer(tools: FeedbackTools, version: string, activity: McpActivity): McpServer {
    const mcp = new McpServer(
        { name: 'pinboard', version },
        {
            instructions:
                'Pinboard holds code feedback the developer pinned in their editor. Start with feedback_list to read anything already waiting, acknowledge it, then close each item with feedback_resolve and a real summary. feedback_watch blocks for the next batch.',
        },
    );
    registerFeedbackTools(mcp, tools, activity);
    return mcp;
}

/**
 * Starts the server and resolves once it is actually listening.
 *
 * `requestedPort` of 0 lets the operating system pick, which is right when the editor is told the
 * address directly. A fixed port only matters when someone writes a client config by hand.
 *
 * `version` is what clients read back as the server's version, and comes from the extension manifest
 * so it cannot fall behind a release.
 */
export async function startMcpServer(
    tools: FeedbackTools,
    requestedPort: number,
    log: (message: string) => void,
    version: string,
): Promise<RunningMcpServer> {
    // One session per client, kept so follow-up requests reach the session that started them.
    const sessions = new Map<string, Session>();

    let lastToolCallAt: number | null = null;
    let lastToolName: string | null = null;
    const listeners: (() => void)[] = [];
    const notify = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };
    const activity: McpActivity = {
        record(toolName) {
            lastToolCallAt = Date.now();
            lastToolName = toolName;
            notify();
        },
    };

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
            await existing.transport.handleRequest(req, res);
            return;
        }

        // No session yet: this must be an initialize, which gets a transport and a server of its own.
        const port = (http.address() as AddressInfo).port;
        const mcp = createMcpServer(tools, version, activity);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: allowedHosts(port),
            onsessioninitialized: id => {
                sessions.set(id, { transport, mcp });
                log(`session ${id} opened`);
                notify();
            },
            onsessionclosed: id => {
                sessions.delete(id);
                log(`session ${id} closed`);
                notify();
            },
        });
        transport.onclose = () => {
            if (transport.sessionId) {
                sessions.delete(transport.sessionId);
                notify();
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
        observe: () => ({ sessions: sessions.size, lastToolCallAt, lastToolName }),
        onActivity(listener) {
            listeners.push(listener);
        },
        async dispose() {
            listeners.length = 0;
            // Snapshot first: closing a transport fires onclose, which mutates the map.
            for (const session of [...sessions.values()]) {
                await session.transport.close().catch(() => undefined);
                await session.mcp.close().catch(() => undefined);
            }
            sessions.clear();
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
