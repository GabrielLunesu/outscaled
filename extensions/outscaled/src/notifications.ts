/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Terminal } from '@outscaled/protocol';
import type { DaemonService } from './daemon/service';
import type { ServerState } from './daemon/state';
import type { TerminalGrid } from './grid/controller';
import type { WorkspaceSelection } from './workspaces/selection';
import type { WorkspaceLocation } from './workspaces/uri';

type Kind = 'needs_input' | 'crashed';
interface NotifyRequest { id: string; title: string; body: string; processId?: number; }
interface NotificationHost {
	enabled(): boolean;
	focused(): boolean;
	pane(host: string, terminalId: string): { processId?: number; visible: boolean } | undefined;
	notify(request: NotifyRequest): PromiseLike<{ shown: boolean; clicked: boolean } | undefined>;
	message(request: NotifyRequest, kind: Kind): PromiseLike<boolean>;
	focus(workspace: WorkspaceLocation, name: string): PromiseLike<unknown>;
	log(message: string): void;
}

function attention(terminal: Terminal): Kind | undefined {
	if (terminal.state === 'crashed') return 'crashed';
	return terminal.state === 'running' && terminal.status === 'needs_input' ? 'needs_input' : undefined;
}

/** Baselines are copied values: daemon stream messages mutate Terminal objects in place. */
export class TerminalNotifications implements vscode.Disposable {
	private readonly previous = new Map<string, Map<string, Kind | undefined>>();
	private readonly subscription: vscode.Disposable;
	private stopped = false;

	constructor(private readonly service: Pick<DaemonService, 'servers' | 'onDidChange'>, private readonly host: NotificationHost) {
		this.update();
		this.subscription = service.onDidChange(() => this.update());
	}

	private update(): void {
		for (const host of this.previous.keys()) if (!this.service.servers.some(server => server.host === host && server.online)) this.previous.delete(host);
		for (const server of this.service.servers) {
			if (!server.online) continue;
			const previous = this.previous.get(server.host);
			const next = new Map(server.terminals.map(terminal => [terminal.id, attention(terminal)]));
			// Commit before dispatching: neither a pending toast nor a suppressed one
			// should cause duplicate notifications on the next health/state update.
			this.previous.set(server.host, next);
			if (!previous) continue; // Startup and reconnect snapshots establish a baseline.
			for (const terminal of server.terminals) {
				const kind = next.get(terminal.id);
				if (!kind || previous.get(terminal.id) === kind || !this.host.enabled()) continue;
				const pane = this.host.pane(server.host, terminal.id);
				if (this.host.focused() && pane?.visible) continue;
				this.show(server, terminal, kind, pane?.processId);
			}
		}
	}

	private show(server: ServerState, terminal: Terminal, kind: Kind, processId?: number): void {
		const { id, name, workspace } = terminal;
		const request = {
			id: `outscaled:${JSON.stringify([server.host, id, kind])}`,
			title: `${name} · ${workspace} · ${server.host}`,
			body: kind === 'needs_input' ? 'Needs your input' : 'Crashed',
			...(processId === undefined ? {} : { processId })
		};
		const focus = async (clicked: boolean) => {
			if (!clicked || this.stopped) return;
			// Either notification can outlive the terminal or its server registration.
			if (!this.service.servers.some(current => current.host === server.host && current.online && current.terminals.some(terminal => terminal.id === id))) return;
			// The sidebar command serializes switching before focus/open, and persists
			// its open request if entering the dedicated workspace reloads the window.
			await this.host.focus({ host: server.host, slug: workspace }, name);
		};
		const toast = async () => focus(!!(await this.host.notify(request))?.clicked);
		const message = async () => focus(await this.host.message(request, kind));
		// macOS can silently drop a toast and leave its promise pending forever.
		// Deliver and handle each surface independently, including errors.
		void toast().catch(error => this.host.log(`Notification: ${String(error)}`));
		void message().catch(error => this.host.log(`Notification: ${String(error)}`));
	}

	dispose(): void { this.stopped = true; this.subscription.dispose(); this.previous.clear(); }
}

/** Any group's active terminal tab is visible, even when another group has focus. */
export function paneVisible(workspace: WorkspaceLocation, selected: WorkspaceLocation | undefined, tab: vscode.Tab | undefined, groups: readonly vscode.TabGroup[]): boolean {
	return tab !== undefined && selected?.host === workspace.host && selected.slug === workspace.slug && groups.some(group => group.activeTab === tab);
}

export function registerNotifications(context: vscode.ExtensionContext, service: DaemonService, selection: WorkspaceSelection,
	grid: TerminalGrid, log: (message: string) => void): void {
	context.subscriptions.push(new TerminalNotifications(service, {
		enabled: () => vscode.workspace.getConfiguration('outscaled').get<boolean>('notifications.enabled', true),
		focused: () => vscode.window.state.focused,
		pane: (host, id) => {
			const pane = grid.findPane(host, id);
			return pane && { processId: pane.processId,
				visible: paneVisible(pane.workspace, selection.current, pane.tab, vscode.window.tabGroups.all) };
		},
		notify: request => vscode.commands.executeCommand('_outscaled.notify', request),
		message: async (request, kind) => {
			const focus = vscode.l10n.t('Focus');
			const text = `${request.title}: ${request.body}`;
			const selected = kind === 'needs_input'
				? await vscode.window.showWarningMessage(text, focus)
				: await vscode.window.showErrorMessage(text, focus);
			return selected === focus;
		},
		focus: (workspace, name) => vscode.commands.executeCommand('outscaled.focusTerminal', workspace, name),
		log
	}));
}
