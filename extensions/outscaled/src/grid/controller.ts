/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { agentsInspectCommand, agentsPublishCommand, agentsRequestCommand, AgentsReceipt, isAgentsReceipt, isAgentsRequest } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsBridge.js';
import { presetLayout } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLayout.js';
import { DaemonService } from '../daemon/service';
import { WorkspaceSelection } from '../workspaces/selection';
import { containsUri, WorkspaceLocation } from '../workspaces/uri';
import { workspaceKey } from '../workspaces/identity';
import { createTerminal, ensureTerminal, listTerminals } from './daemonTerminals';
import { applyGridRequest, openGridPane, GridMemory, gridMemoryKey } from './memory';
import { PresetStore, builtInPresets, expandPreset, presets } from './presets';
import { attachEnv, findWsPath } from './wsPath';
import { AgentsLaunch, insertLaunch, launchLayout } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLaunch.js';
import { planLaunch } from './launch';
import { changeSchedule, createSchedules } from './schedules';
import { agentsSnapshot } from './mapping';
import { answerTerminal } from './answers';

/** Read-only subset of the built-in Git extension's v1 API. */
interface GitExtension { enabled: boolean; getAPI(version: 1): { repositories: readonly { rootUri: vscode.Uri; state: { HEAD: { name?: string } | undefined } }[] } }

const pendingKey = 'outscaled.pendingGridOpen';
type OpenRequest = { kind: 'preset'; workspace: WorkspaceLocation; preset: string } | { kind: 'focus'; workspace: WorkspaceLocation; name: string; focused?: string; openInGrid?: boolean };

/** Extension-owned daemon operations; core alone owns the live terminal clients. */
export class TerminalGrid implements vscode.Disposable {
	readonly memory: GridMemory;
	private queue = Promise.resolve();
	private readonly presetStore = new PresetStore();
	private stopped = false;
	private executable?: string;
	private receipt?: AgentsReceipt;
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext, private readonly service: DaemonService,
		private readonly selection: WorkspaceSelection, private readonly log: (message: string) => void) {
		this.memory = new GridMemory(context.workspaceState.get(gridMemoryKey));
		this.subscriptions.push(selection.onWillChangeSelectedWorkspace(event => { event.waitUntil(this.enqueue(() => this.publish(undefined, event.current))); }),
			service.onDidChange(() => { void this.enqueue(() => this.publish()); }),
			selection.onDidChangeSelectedWorkspace(event => { event.waitUntil(this.enqueue(() => this.publish())); }),
			vscode.commands.registerCommand('outscaled.openGrid', async () => {
				try {
					const workspace = this.selection.current;
					if (!workspace) { await vscode.commands.executeCommand('outscaled.switchWorkspace'); return; }
					const choice = await vscode.window.showQuickPick(presets.map(preset => ({ label: vscode.l10n.t(preset.label), preset })), { placeHolder: vscode.l10n.t('Open a terminal grid') });
					if (choice) {await this.open({ kind: 'preset', workspace, preset: choice.preset.id });}
				} catch (error) { this.report(error); }
			}),
			vscode.commands.registerCommand('outscaled.focusTerminal', (workspace: WorkspaceLocation, name: string) => this.open({ kind: 'focus', workspace, name }).catch(error => this.report(error))),
			vscode.commands.registerCommand(agentsRequestCommand, async (value: unknown): Promise<AgentsReceipt> => {
				if (!isAgentsRequest(value)) { this.log('Invalid agents bridge request'); return { version: 1, ok: false, error: 'Invalid request' }; }
				try {
					if (value.action === 'newAgents') {await vscode.commands.executeCommand('outscaled.agents.new');}
					else {
						const snapshot = this.snapshot();
						const workspace = snapshot.workspaces.find(workspace => workspace.id === value.workspace);
						if (!workspace) {throw new Error(vscode.l10n.t('Workspace is unavailable'));}
						const location = { host: workspace.server, slug: workspace.name };
						if (value.action === 'presets' || value.action === 'savePreset') {
							if (value.action === 'savePreset') { await this.enqueue(() => this.presetStore.save(value.workspace, value.name, value.choices)); }
							return { version: 1, ok: true, presets: [...builtInPresets().map(preset => ({ ...preset, name: vscode.l10n.t(preset.name) })), ...await this.presetStore.load(value.workspace)] };
						}
						if (value.action === 'background' || value.action === 'resize') {
							await this.enqueue(async () => {
								const current = this.snapshot().workspaces.find(workspace => workspace.id === value.workspace);
								if (!current?.selected) { throw new Error(vscode.l10n.t('Select this workspace before changing its grid')); }
								const focus = applyGridRequest(this.memory, location, current.layout, value, current.terminals.map(terminal => terminal.id));
								await this.publish(focus ? { workspace: value.workspace, terminal: focus } : undefined);
							});
						}
						else if (value.action === 'schedule' || value.action === 'editSchedule') {
							await this.enqueue(async () => {
								try { await changeSchedule(this.service, location, value); }
								finally { await this.service.synchronize(location.host); await this.publish(); }
							});
						}
						else if (value.action === 'launch') { await this.launch(location, value.choices, value.focused); }
						else if (value.action === 'switch') {await vscode.commands.executeCommand('outscaled.switchWorkspace', location);}
						else {
							const terminal = workspace.terminals.find(terminal => terminal.id === value.terminal);
							if (!terminal) {throw new Error(vscode.l10n.t('Terminal is unavailable'));}
							if (value.action === 'answer') {
								const outcome = await answerTerminal(this.service, location, terminal.name, value.answer,
									() => this.open({ kind: 'focus', workspace: location, name: terminal.name }),
									message => { void vscode.window.showInformationMessage(message); });
								return { version: 1, ok: true, jumped: outcome === 'jumped' };
							}
							await this.open({ kind: 'focus', workspace: location, name: terminal.name, openInGrid: value.action === 'openInGrid', focused: value.action === 'openInGrid' ? value.focused : undefined });
						}
					}
					return { version: 1, ok: true };
				} catch (error) { this.log(String(error)); return { version: 1, ok: false, error: String(error) }; }
			}));
		void this.enqueue(async () => {
			try { this.executable = await findWsPath(vscode.workspace.getConfiguration('outscaled').get<string>('wsPath')); }
			catch (error) { this.log(String(error)); }
			await this.publish();
		});
		const pending = context.globalState.get<OpenRequest>(pendingKey);
		if (pending && selection.current && workspaceKey(pending.workspace) === workspaceKey(selection.current)) {
			void context.globalState.update(pendingKey, undefined).then(() => this.open(pending));
		}
	}

	private snapshot(selected = this.selection.current) {
		const branches = new Map<string, string>();
		const git = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (git?.isActive && git.exports.enabled) {
			for (const server of this.service.servers.filter(server => server.host === 'local')) {
				for (const workspace of server.workspaces) {
					const repository = git.exports.getAPI(1).repositories.find(repository => containsUri(repository.rootUri, vscode.Uri.file(workspace.path)));
					if (repository?.state.HEAD?.name) { branches.set(workspaceKey({ host: server.host, slug: workspace.slug }), repository.state.HEAD.name); }
				}
			}
		}

		return agentsSnapshot(this.service.servers, selected, this.memory, this.executable, attachEnv(), branches);
	}
	private enqueue(action: () => Promise<void>): Promise<void> {
		const result = this.queue.then(async () => { if (!this.stopped) {await action();} });
		this.queue = result.catch(error => this.log(String(error)));
		return result;
	}
	private async publish(focus?: { workspace: string; terminal: string }, selected = this.selection.current): Promise<void> {
		const snapshot = { ...this.snapshot(selected), focus };
		for (const workspace of snapshot.workspaces) {this.memory.remember({ host: workspace.server, slug: workspace.name }, workspace.layout, workspace.terminals.map(terminal => terminal.id));}
		await this.context.workspaceState.update(gridMemoryKey, this.memory.serialize());
		const receipt = await vscode.commands.executeCommand<unknown>(agentsPublishCommand, snapshot);
		if (!isAgentsReceipt(receipt)) { this.log('Invalid agents bridge receipt'); return; }
		if (!receipt.ok) { this.log(receipt.error ?? 'Agents bridge rejected snapshot'); return; }
		this.receipt = receipt;
	}
	private async open(request: OpenRequest): Promise<void> {
		if (!this.selection.current || workspaceKey(this.selection.current) !== workspaceKey(request.workspace)) {
			await this.context.globalState.update(pendingKey, request);
			await vscode.commands.executeCommand('outscaled.switchWorkspace', request.workspace);
			if (!this.selection.current || workspaceKey(this.selection.current) !== workspaceKey(request.workspace)) {return;}
			await this.context.globalState.update(pendingKey, undefined);
		}
		await this.enqueue(async () => {
			this.executable = await findWsPath(vscode.workspace.getConfiguration('outscaled').get<string>('wsPath'));
			let focus: string | undefined;
			if (request.kind === 'preset') {
				const preset = presets.find(preset => preset.id === request.preset);
				if (!preset) {throw new Error(vscode.l10n.t('Unknown grid preset'));}
				const { panes } = expandPreset(preset);
				const ids: string[] = [];
				for (const pane of panes) {ids.push((await ensureTerminal(this.service, request.workspace, pane)).id);}
				this.memory.remember(request.workspace, presetLayout(preset.layout, ids), (await listTerminals(this.service, request.workspace)).map(terminal => terminal.id));
				focus = ids[0];
			} else {
				focus = (await listTerminals(this.service, request.workspace)).find(terminal => terminal.name === request.name)?.id;
				if (!focus) {throw new Error(vscode.l10n.t('This terminal is unavailable'));}
				const tree = this.memory.recall(request.workspace) ?? presetLayout('single', []);
				if (request.openInGrid) { this.memory.remember(request.workspace, openGridPane(tree, focus, request.focused)); }
			}
			await this.service.synchronize(request.workspace.host);
			await this.publish(focus ? { workspace: workspaceKey(request.workspace), terminal: focus } : undefined);
		});
	}
	private async launch(workspace: WorkspaceLocation, choices: AgentsLaunch, focused?: string): Promise<void> {
		if (!this.selection.current || workspaceKey(workspace) !== workspaceKey(this.selection.current)) { throw new Error(vscode.l10n.t('Select this workspace before launching agents')); }
		await this.enqueue(async () => {
			this.executable = await findWsPath(vscode.workspace.getConfiguration('outscaled').get<string>('wsPath'));
			const terminals = await listTerminals(this.service, workspace);
			if (choices.run === 'scheduled') {
				try { await createSchedules(this.service, workspace, choices, terminals.map(terminal => terminal.name)); }
				finally { await this.service.synchronize(workspace.host); await this.publish(); }
				return;
			}
			const tree = this.snapshot().workspaces.find(candidate => candidate.id === workspaceKey(workspace))!.layout;
			const plan = planLaunch(choices, terminals.map(terminal => terminal.name), tree, focused);
			const ids: string[] = [];
			try {
				for (const pane of plan.panes) { ids.push((await createTerminal(this.service, workspace, pane)).id); }
				const layout = insertLaunch(tree, launchLayout(choices, ids), choices.where, focused);
				this.memory.remember(workspace, layout, [...terminals.map(terminal => terminal.id), ...ids]);
				await this.context.workspaceState.update(gridMemoryKey, this.memory.serialize());
			} finally {
				// Reconcile partial launches too; accepted daemon operations are never rolled back by stopping agents.
				await this.service.synchronize(workspace.host);
				await this.publish(ids[0] ? { workspace: workspaceKey(workspace), terminal: ids[0] } : undefined);
			}
		});
	}

	async findPane(host: string, terminalId: string) {
		const receipt = await vscode.commands.executeCommand<unknown>(agentsInspectCommand);
		if (isAgentsReceipt(receipt) && receipt.ok) {this.receipt = receipt;}
		const workspaces = new Set(this.service.servers.filter(server => server.host === host).flatMap(server => server.workspaces.map(workspace => workspaceKey({ host, slug: workspace.slug }))));
		return this.receipt?.panes?.find(pane => workspaces.has(pane.workspace) && pane.terminal === terminalId);
	}
	private report(error: unknown): void { this.log(String(error)); void vscode.window.showErrorMessage(vscode.l10n.t('Outscaled: {0}', String(error))); }
	async flush(): Promise<void> { await this.queue; }
	dispose(): void { this.stopped = true; for (const subscription of this.subscriptions) {subscription.dispose();} }
}
