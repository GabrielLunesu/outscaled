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
import { ensureTerminal, listTerminals } from './daemonTerminals';
import { detachPanes } from './detach';
import { GridMemory, gridMemoryKey, RememberedGrid, RememberedPane, recordGrid, restorePlan } from './memory';
import { EditorGroupLayout, expandPreset, GridPane, presets } from './presets';
import { TabStatusChanges } from './status';
import { attachArgs, attachEnv, findWsPath } from './wsPath';

const pendingKey = 'outscaled.pendingGridOpen';
type OpenRequest = { workspace: WorkspaceLocation; preset: string } | { workspace: WorkspaceLocation; name: string };
interface LivePane { workspace: WorkspaceLocation; terminalId: string; terminal: vscode.Terminal; processId?: number; closed: boolean; pane: RememberedPane; tab?: vscode.Tab; excludedTabs: ReadonlySet<vscode.Tab>; }

/** Owns attach clients only. wsd owns their lifetime and survives client disposal. */
export class TerminalGrid implements vscode.Disposable {
	readonly memory: GridMemory;
	private readonly panes = new Set<LivePane>();
	private readonly statuses = new TabStatusChanges();
	private statusQueue = Promise.resolve();
	private queue = Promise.resolve();
	private stopped = false;
	private changing = false;
	private canRecord = false;
	private snapshotTimer?: NodeJS.Timeout;
	private readonly layoutTimer: NodeJS.Timeout;
	private readonly subscriptions: vscode.Disposable[];

	constructor(private readonly context: vscode.ExtensionContext, private readonly service: DaemonService,
		private readonly selection: WorkspaceSelection, private readonly log: (message: string) => void) {
		this.memory = new GridMemory(context.workspaceState.get<Record<string, RememberedGrid>>(gridMemoryKey));
		this.subscriptions = [service.onDidChange(() => this.updateStatuses()), vscode.window.onDidCloseTerminal(terminal => {
			for (const pane of this.panes) if (pane.terminal === terminal) this.remove(pane);
			this.scheduleSnapshot();
		}), selection.onWillChangeSelectedWorkspace(event => {
			event.waitUntil(this.enqueue(async () => {
				this.changing = true;
				if (event.previous) await this.record(event.previous);
				await this.detach();
				this.canRecord = false;
			}));
		}), selection.onDidChangeSelectedWorkspace(event => {
			event.waitUntil(this.enqueue(async () => {
				try { await this.restore(event.current); this.canRecord = true; } finally { this.changing = false; }
			}));
		}), vscode.window.tabGroups.onDidChangeTabs(() => {
			this.bindMovedTabs();
			this.scheduleSnapshot();
		}), vscode.window.tabGroups.onDidChangeTabGroups(() => { this.bindMovedTabs(); this.scheduleSnapshot(); }), vscode.commands.registerCommand('outscaled.openGrid', (node?: { server: { host: string }; workspace: { slug: string } }) => (async () => {
			const workspace = node ? { host: node.server.host, slug: node.workspace.slug } : this.selection.current;
			if (!workspace) throw new Error('Select an Outscaled workspace first.');
			const preset = await vscode.window.showQuickPick(presets.map(preset => ({ label: preset.label, preset })), {
				placeHolder: vscode.l10n.t('Open a terminal grid')
			});
			if (preset) await this.open({ workspace, preset: preset.preset.id });
		})().catch(error => this.report(error))), vscode.commands.registerCommand('outscaled.focusTerminal', (workspace: WorkspaceLocation, name: string) =>
			this.open({ workspace, name }).catch(error => this.report(error)))];
		// Local layout polling also captures sash resizes (the tabs API has no resize
		// event). Writes are deduplicated, and every switch takes a fresh snapshot.
		this.layoutTimer = setInterval(() => this.scheduleSnapshot(), 1000);
		// Transient clients are never restored by VS Code itself.
		void this.enqueue(async () => {
			this.changing = true;
			try {
				const pending = context.globalState.get<OpenRequest>(pendingKey);
				if (pending && workspaceKey(pending.workspace) === (selection.current && workspaceKey(selection.current))) {
					await context.globalState.update(pendingKey, undefined);
					await this.perform(pending);
				} else if (selection.current) {
					await this.restore(selection.current);
				}
				this.canRecord = true;
			} finally { this.changing = false; }
		});
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const result = this.queue.then(async () => { if (!this.stopped) await action(); });
		this.queue = result.catch(error => this.report(error));
		return this.queue;
	}

	/** Read-only attach-client lookup; daemon identity also works across workspace switches. */
	findPane(host: string, terminalId: string): Readonly<LivePane> | undefined {
		return [...this.panes].find(pane => !pane.closed && pane.workspace.host === host && pane.terminalId === terminalId);
	}

	private async open(request: OpenRequest): Promise<void> {
		if (!this.selection.current || workspaceKey(this.selection.current) !== workspaceKey(request.workspace)) {
			await this.context.globalState.update(pendingKey, request);
			await vscode.commands.executeCommand('outscaled.switchWorkspace', request.workspace);
			if (!this.selection.current || workspaceKey(this.selection.current) !== workspaceKey(request.workspace)) return;
			await this.context.globalState.update(pendingKey, undefined);
		}
		await this.enqueue(async () => {
			this.changing = true;
			try {
				if (this.selection.current && workspaceKey(this.selection.current) === workspaceKey(request.workspace)) {
					await this.perform(request);
					this.canRecord = true;
				}
			} finally { this.changing = false; }
		});
	}

	private async perform(request: OpenRequest): Promise<void> {
		const workspace = request.workspace;
		if ('name' in request) {
			const existing = [...this.panes].find(pane => workspaceKey(pane.workspace) === workspaceKey(workspace) && pane.pane.name === request.name);
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
			await this.detach();
			await vscode.commands.executeCommand('vscode.setEditorLayout', layout.editor);
			this.memory.remember(workspace, { layout: layout.editor, preset: preset.id,
				panes: panes.map((pane, index) => ({ ...pane, terminalId: terminals[index].id })) });
			await this.save();
			for (const [index, pane] of panes.entries()) await this.attach(workspace, pane, terminals[index], ws);
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
			await this.attach(workspace, pane, terminal, ws);
		}
	}

	private async attach(workspace: WorkspaceLocation, pane: GridPane, daemon: DaemonTerminal, ws: string): Promise<void> {
		// TabInputTerminal has no terminal id. Bind the newly opened tab while
		// attaching sequentially, then retain its object rather than matching labels
		// in snapshots. On cross-group moves VS Code replaces that tab object.
		const before = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
		let resolve!: (tab: vscode.Tab) => void;
		let reject!: (error: Error) => void;
		const opened = new Promise<vscode.Tab>((yes, no) => { resolve = yes; reject = no; });
		const check = () => {
			const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
				!before.has(tab) && tab.input instanceof vscode.TabInputTerminal && tab.label === pane.name);
			if (tab) resolve(tab);
		};
		const subscriptions = [vscode.window.tabGroups.onDidChangeTabs(check), vscode.window.tabGroups.onDidChangeTabGroups(check)];
		const timer = setTimeout(() => reject(new Error(`Terminal tab did not open: ${pane.name}`)), 10000);
		const terminal = vscode.window.createTerminal({ name: pane.name, shellPath: ws,
			shellArgs: attachArgs(workspace.host, workspace.slug, pane.name), env: attachEnv(),
			isTransient: true, location: { viewColumn: pane.viewColumn } });
		const live: LivePane = { workspace, terminalId: daemon.id, terminal, closed: false, excludedTabs: before, pane: { ...pane, terminalId: daemon.id } };
		this.panes.add(live);
		terminal.show();
		void terminal.processId.then(processId => {
			if (live.closed || this.stopped) return;
			live.processId = processId;
			this.updateStatuses();
		}, error => this.log(`Terminal process: ${String(error)}`));
		try { live.tab = await opened; }
		finally { clearTimeout(timer); for (const subscription of subscriptions) subscription.dispose(); }
	}

	private bindMovedTabs(): void {
		const tabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
		const bound = new Set([...this.panes].map(pane => pane.tab));
		for (const pane of this.panes) if (pane.tab && !tabs.has(pane.tab)) {
			const replacement = [...tabs].find(tab => !bound.has(tab) && !pane.excludedTabs.has(tab) && tab.input instanceof vscode.TabInputTerminal && tab.label === pane.terminal.name);
			if (replacement) { pane.tab = replacement; bound.add(replacement); }
		}
	}

	private report(error: unknown): void {
		this.log(String(error));
		void vscode.window.showErrorMessage(`Outscaled: ${String(error)}`);
	}

	private scheduleSnapshot(): void {
		if (this.changing || this.stopped || !this.selection.current) return;
		clearTimeout(this.snapshotTimer);
		this.snapshotTimer = setTimeout(() => {
			void this.enqueue(async () => {
				if (!this.changing && this.selection.current) await this.record(this.selection.current);
			});
		}, 100);
	}

	private async record(workspace: WorkspaceLocation): Promise<void> {
		if (!this.canRecord) return;
		this.bindMovedTabs();
		const previous = this.memory.recall(workspace);
		const panes = [...this.panes].filter(pane => workspaceKey(pane.workspace) === workspaceKey(workspace));
		if (!previous && !panes.length) return;
		const layout = await vscode.commands.executeCommand<EditorGroupLayout>('vscode.getEditorLayout');
		if (!layout) return;
		const grid = recordGrid(layout, vscode.window.tabGroups.all, panes, previous?.preset);
		if (JSON.stringify(grid) === JSON.stringify(previous)) return;
		this.memory.remember(workspace, grid);
		await this.save();
	}

	private async detach(): Promise<void> {
		const panes = [...this.panes];
		for (const pane of panes) this.remove(pane);
		await detachPanes(panes, vscode.window.tabGroups, this.log);
	}

	private async restore(workspace: WorkspaceLocation): Promise<void> {
		const remembered = this.memory.recall(workspace);
		if (!remembered) return;
		this.changing = true;
		const terminals = await listTerminals(this.service, workspace);
		const plan = restorePlan(remembered, terminals);
		const ws = plan.panes.length ? await findWsPath(vscode.workspace.getConfiguration('outscaled').get<string>('wsPath')) : '';
		await vscode.commands.executeCommand('vscode.setEditorLayout', plan.layout);
		for (const pane of plan.panes) await this.attach(workspace, pane, terminals.find(terminal => terminal.id === pane.terminalId)!, ws);
		this.memory.remember(workspace, plan);
		await this.save();
	}

	/** Flush sash changes before an intentional extension-host shutdown/reload. */
	async flush(): Promise<void> {
		await this.queue;
		if (!this.changing && this.selection.current) await this.record(this.selection.current);
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
		clearInterval(this.layoutTimer);
		clearTimeout(this.snapshotTimer);
		for (const subscription of this.subscriptions) subscription.dispose();
		for (const pane of this.panes) this.remove(pane);
	}
}
