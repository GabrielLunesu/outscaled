/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Terminal, Workspace } from '@outscaled/protocol';
import { DaemonService } from '../daemon/service';
import { needsYou, ServerState } from '../daemon/state';

type Node = { kind: 'server'; server: ServerState }
	| { kind: 'workspace'; server: ServerState; workspace: Workspace }
	| { kind: 'terminal'; server: ServerState; terminal: Terminal };

function terminalIcon(terminal: Terminal): vscode.ThemeIcon {
	if (terminal.state === 'crashed') return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
	if (terminal.state === 'exited' || !terminal.status) return new vscode.ThemeIcon('terminal', new vscode.ThemeColor('disabledForeground'));
	if (terminal.status === 'working' || terminal.status === 'starting' || terminal.state === 'restarting') {
		return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('testing.iconPassed'));
	}
	return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(terminal.status === 'needs_input' ? 'testing.iconFailed' : 'descriptionForeground'));
}

export function registerWorkspacesView(context: vscode.ExtensionContext, service: DaemonService): void {
	const changes = new vscode.EventEmitter<Node | undefined>();
	const tree = vscode.window.createTreeView<Node>('outscaled.workspaces', {
		treeDataProvider: {
			onDidChangeTreeData: changes.event,
			getChildren: node => {
				if (!node) return service.servers.map(server => ({ kind: 'server', server }));
				if (node.kind === 'server') return node.server.workspaces.map(workspace => ({ kind: 'workspace', server: node.server, workspace }));
				if (node.kind === 'workspace') return node.server.terminals.filter(t => t.workspace === node.workspace.slug)
					.map(terminal => ({ kind: 'terminal', server: node.server, terminal }));
				return [];
			},
			getTreeItem: node => {
				const hostId = JSON.stringify([node.server.host]);
				if (node.kind === 'server') {
					const item = new vscode.TreeItem(node.server.host, vscode.TreeItemCollapsibleState.Expanded);
					item.id = `server:${hostId}`;
					item.contextValue = 'outscaled.server';
					item.iconPath = new vscode.ThemeIcon(node.server.online ? 'remote' : 'debug-disconnect');
					item.description = node.server.online ? vscode.l10n.t('online · {0}/{1} terminals running', node.server.health!.terminals.running, node.server.health!.terminals.total) : vscode.l10n.t('offline');
					item.tooltip = node.server.online ? vscode.l10n.t('{0}\n{1}\n{2}', node.server.host, node.server.health!.name, item.description) : `${node.server.host}\n${node.server.error ?? vscode.l10n.t('Offline')}`;
					return item;
				}
				if (node.kind === 'workspace') {
					const item = new vscode.TreeItem(node.workspace.slug, vscode.TreeItemCollapsibleState.Expanded);
					item.id = `workspace:${JSON.stringify([node.server.host, node.workspace.slug])}`;
					item.contextValue = 'outscaled.workspace';
					item.iconPath = new vscode.ThemeIcon('folder');
					const count = needsYou(node.server.terminals.filter(t => t.workspace === node.workspace.slug));
					item.description = count ? vscode.l10n.t('{0} need you', count) : undefined;
					item.tooltip = [node.workspace.path, node.workspace.repo].filter(Boolean).join('\n');
					return item;
				}
				const terminal = node.terminal;
				const item = new vscode.TreeItem(terminal.name);
				item.id = `terminal:${JSON.stringify([node.server.host, terminal.id])}`;
				item.contextValue = 'outscaled.terminal';
				item.iconPath = terminalIcon(terminal);
				item.description = terminal.state === 'running' ? (terminal.status === 'needs_input' ? vscode.l10n.t('needs you') : terminal.status ?? vscode.l10n.t('shell')) : terminal.state;
				item.tooltip = `${terminal.command}\n${terminal.state}${terminal.status ? ` · ${terminal.status}` : ''}`;
				return item;
			}
		}
	});
	const update = () => {
		changes.fire(undefined);
		const count = service.servers.reduce((sum, server) => sum + needsYou(server.terminals), 0);
		tree.badge = count ? { value: count, tooltip: vscode.l10n.t('{0} terminals need you', count) } : undefined;
		// VS Code hides viewsWelcome for nonempty trees. Use the same message above
		// the roots so offline/empty servers remain visible as well.
		tree.message = service.servers.some(s => s.workspaces.length > 0) ? undefined
			: vscode.l10n.t('No workspaces found. Start wsd locally or add SSH hosts to your Outscaled servers.toml.');
		void vscode.commands.executeCommand('setContext', 'outscaled.hasWorkspaces', service.servers.some(s => s.workspaces.length > 0));
	};
	context.subscriptions.push(changes, tree, service.onDidChange(update),
		vscode.commands.registerCommand('outscaled.workspaces.refresh', () => service.refresh()));
	update();
}
