/**
 * Hands the running server to the editor's own agent.
 *
 * This is the piece that means a VS Code user configures nothing: the extension publishes the
 * server it is already running, and Copilot picks the tools up. Other MCP clients point at the same
 * URL by hand - see the Copy MCP Server Config command.
 *
 * The API has been stable since VS Code 1.101, which is why package.json asks for that version.
 */

import * as vscode from 'vscode';

/** Reports where the server is, or null before it has finished starting. */
export type UrlSource = () => string | null;

export class PinboardServerDefinitionProvider
    implements vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition>
{
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions = this.changed.event;

    constructor(private readonly url: UrlSource) {}

    /** Called eagerly by the editor, so it must not prompt or block on anything. */
    provideMcpServerDefinitions(): vscode.McpHttpServerDefinition[] {
        const url = this.url();
        if (!url) {
            return [];
        }
        return [new vscode.McpHttpServerDefinition('Pinboard', vscode.Uri.parse(url), {}, '0.0.1')];
    }

    /** Nothing to resolve: no authentication, and the server is already listening. */
    resolveMcpServerDefinition(
        server: vscode.McpHttpServerDefinition,
    ): vscode.McpHttpServerDefinition {
        return server;
    }

    /** Tells the editor to ask again, once the port is known. */
    announce(): void {
        this.changed.fire();
    }

    dispose(): void {
        this.changed.dispose();
    }
}
