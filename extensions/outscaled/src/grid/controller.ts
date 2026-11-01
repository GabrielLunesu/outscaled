/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Terminal as DaemonTerminal } from '@outscaled/protocol';
import { DaemonService } from '../daemon/service';
import { WorkspaceSelection } from '../workspaces/selection';
import { WorkspaceLocation } from '../workspaces/uri';
import { workspaceKey } from '../workspaces/editorMemory';
import { ensureTerminal } from './daemonTerminals';
import { GridMemory, gridMemoryKey, RememberedGrid } from './memory';
import { EditorGroupLayout, expandPreset, GridPane, presets } from './presets';
import { TabStatusChanges } from './status';
import { attachArgs, attachEnv, findWsPath } from './wsPath';

const pendingKey = 'outscaled.pendingGridOpen';
type OpenRequest = { workspace: WorkspaceLocation; preset: string } | { workspace: WorkspaceLocation; name: string };
interface LivePane { workspace: WorkspaceLocation; terminalId: string; terminal: vscode.Terminal; processId?: number; closed: boolean; }

/** Owns attach clients only. wsd owns their lifetime and survives client disposal. */
export class TerminalGrid implements vscode.Disposable {
	readonly memory: GridMemory;
	private readonly panes = new Set<LivePane>();
	private readonly statuses = new TabStatusChanges();
	private statusQueue = Promise.resolve();
	private queue = Promise.resolve();
	private stopped = false;
	private readonly subscriptions: vscode.Disposable[];

	constructor(private readonly context: vscode.ExtensionContext, private readonly service: DaemonService,
		private readonly selection: WorkspaceSelection, private readonly log: (message: string) => void) {
		this.memory = new GridMemory(context.workspaceState.get<Record<string, RememberedGrid>>(gridMemoryKey));
		this.subscriptions = [service.onDidChange(() => this.updateStatuses()), vscode.window.onDidCloseTerminal(terminal => {
			for (const pane of this.panes) if (pane.terminal === terminal) this.remove(pane);
		}), vscode.commands.registerCommand('outscaled.openGrid', (node?: { server: { host: string }; workspace: { slug: string } }) => this.enqueue(async () => {
			const workspace = node ? { host: node.server.host, slug: node.workspace.slug } : this.selection.current;
			if (!workspace) throw new Error('Select an Outscaled workspace first.');
			const preset = await vscode.window.showQuickPick(presets.map(preset => ({ label: preset.label, preset })), {
				placeHolder: vscode.l10n.t('Open a terminal grid')
			});
			if (preset) await this.open({ workspace, preset: preset.preset.id });
		})), vscode.commands.registerCommand('outscaled.focusTerminal', (workspace: WorkspaceLocation, name: string) =>
			this.enqueue(() => this.open({ workspace, name })))];
		// The first switch can reload into the dedicated multi-root window. Resume
		// only the explicit open request, not saved grids (restoration is separate).
		void this.enqueue(async () => {
			const pending = context.globalState.get<OpenRequest>(pendingKey);
			if (pending && workspaceKey(pending.workspace) === (selection.current && workspaceKey(selection.current))) {
				await context.globalState.update(pendingKey, undefined);
				await this.perform(pending);
			}
		});
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const result = this.queue.then(async () => { if (!this.stopped) await action(); });
		this.queue = result.catch(error => { this.log(String(error)); void vscode.window.showErrorMessage(`Outscaled: ${String(error)}`); });
		return this.queue;
	}

	private async open(request: OpenRequest): Promise<void> {
		if (!this.selection.current || workspaceKey(this.selection.current) !== workspaceKey(request.workspace)) {
			await this.context.globalState.update(pendingKey, request);
			await vscode.commands.executeCommand('outscaled.switchWorkspace', request.workspace);
			if (!this.selection.current || workspaceKey(this.selection.current) !== workspaceKey(request.workspace)) return;
			await this.context.globalState.update(pendingKey, undefined);
		}
		await this.perform(request);
	}

	private async perform(request: OpenRequest): Promise<void> {
		const workspace = request.workspace;
		if ('name' in request) {
			const existing = [...this.panes].find(pane => workspaceKey(pane.workspace) === workspaceKey(workspace) && pane.terminal.name === request.name);
			if (existing) { existing.terminal.show(); return; }
		}
		// Resolve before launching agents or changing the editor layout.
		const ws = await findWsPath(vscode.workspace.getConfiguration('outscaled').get<string>('wsPath'));
		if ('preset' in request) {
			const preset = presets.find(preset => preset.id === request.preset);
			if (!preset) throw new Error('Unknown grid preset');
			const { layout, panes } = expandPreset(preset);
			const terminals: DaemonTerminal[] = [];
			for (const pane of panes) terminals.push(await ensureTerminal(this.service, workspace, pane));
			for (const pane of [...this.panes]) if (workspaceKey(pane.workspace) === workspaceKey(workspace)) {
				this.remove(pane); pane.terminal.dispose();
			}
			await vscode.commands.executeCommand('vscode.setEditorLayout', layout.editor);
			this.memory.remember(workspace, { layout: layout.editor, preset: preset.id,
				panes: panes.map((pane, index) => ({ ...pane, terminalId: terminals[index].id })) });
			await this.save();
			for (const [index, pane] of panes.entries()) this.attach(workspace, pane, terminals[index], ws);
		} else {
			const response = await this.service.request(workspace.host, `workspaces/${encodeURIComponent(workspace.slug)}/terminals`);
			if (!response.ok) throw new Error(`Could not list terminals (HTTP ${response.status})`);
			const terminal = (await response.json() as DaemonTerminal[]).find(terminal => terminal.name === request.name);
			if (!terminal || terminal.state !== 'running') throw new Error('This terminal is not running.');
			const viewColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
			const pane = { name: terminal.name, command: terminal.command, viewColumn, terminalId: terminal.id };
			const previous = this.memory.recall(workspace);
			const layout = await vscode.commands.executeCommand<EditorGroupLayout>('vscode.getEditorLayout');
			this.memory.remember(workspace, { layout: layout ?? { orientation: 0, groups: [{}] },
				panes: [...(previous?.panes.filter(pane => pane.name !== terminal.name) ?? []), pane] });
			await this.save();
			this.attach(workspace, pane, terminal, ws);
		}
	}

	private attach(workspace: WorkspaceLocation, pane: GridPane, daemon: DaemonTerminal, ws: string): void {
		const terminal = vscode.window.createTerminal({ name: pane.name, shellPath: ws,
			shellArgs: attachArgs(workspace.host, workspace.slug, pane.name), env: attachEnv(),
			isTransient: true, location: { viewColumn: pane.viewColumn } });
		const live: LivePane = { workspace, terminalId: daemon.id, terminal, closed: false };
		this.panes.add(live);
		terminal.show();
		void terminal.processId.then(processId => {
			if (live.closed || this.stopped) return;
			live.processId = processId;
			this.updateStatuses();
		}, error => this.log(`Terminal process: ${String(error)}`));
	}

	private updateStatuses(): void {
		this.statusQueue = this.statusQueue.then(async () => {
			if (this.stopped) return;
			for (const pane of this.panes) {
				const terminal = this.service.servers.find(server => server.host === pane.workspace.host)?.terminals.find(terminal => terminal.id === pane.terminalId);
				if (!pane.closed && pane.processId && terminal) await this.statuses.update(pane.processId, terminal,
					request => vscode.commands.executeCommand<boolean>('_outscaled.setTerminalStatus', request));
			}
		}).catch(error => this.log(`Terminal status: ${String(error)}`));
	}
	private save(): Thenable<void> { return this.context.workspaceState.update(gridMemoryKey, this.memory.serialize()); }
	private remove(pane: LivePane): void {
		pane.closed = true;
		this.panes.delete(pane);
		if (pane.processId) this.statuses.forget(pane.processId);
	}
	dispose(): void {
		this.stopped = true;
		for (const subscription of this.subscriptions) subscription.dispose();
		for (const pane of this.panes) this.remove(pane);
	}
}
