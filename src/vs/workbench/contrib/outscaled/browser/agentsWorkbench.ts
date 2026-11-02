/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IEditorGroupsService, IEditorWorkingSet } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { AgentsMode, AgentsReceipt, AgentsSnapshot, agentsInspectCommand, agentsPublishCommand, isAgentsSnapshot } from '../common/agentsBridge.js';
import { AgentsInput } from './agentsEditor.js';
import { IAgentsService } from './agentsService.js';
import { agentsSidebarId } from './agentsSidebar.js';
import './media/agentsView.css';

const IAgentsWorkbench = createDecorator<IAgentsWorkbench>('outscaledAgentsWorkbench');
interface IAgentsWorkbench {
	readonly _serviceBrand: undefined;
	publish(snapshot: AgentsSnapshot): Promise<AgentsReceipt>;
	setMode(mode: AgentsMode): Promise<void>;
}
interface WorkspaceMode { mode: AgentsMode; code?: IEditorWorkingSet }
const storageKey = 'outscaled.workspaceModes.v1';

/** Serializes mode/root transitions; native working sets preserve Code editors and their layout. */
class AgentsWorkbench extends Disposable implements IAgentsWorkbench {
	declare readonly _serviceBrand: undefined;
	private readonly options = this._register(new MutableDisposable());
	private readonly modes: Record<string, WorkspaceMode>;
	private selected: string | undefined;
	private queue = Promise.resolve();
	private transitioning = false;
	private readonly input = this._register(new MutableDisposable<AgentsInput>());
	constructor(@IAgentsService private readonly agents: IAgentsService, @IEditorService private readonly editors: IEditorService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService, @IPaneCompositePartService private readonly sidebar: IPaneCompositePartService,
		@IStorageService private readonly storage: IStorageService, @ILogService private readonly log: ILogService) {
		super();
		this.modes = storage.getObject<Record<string, WorkspaceMode>>(storageKey, StorageScope.WORKSPACE, {});
		this._register(storage.onWillSaveState(() => { if (!this.transitioning && this.agents.mode === 'code') { this.rememberCode(); } this.save(); }));
		// Native split commands create an empty group even for singleton inputs.
		// Agents owns the full editor area; Code keeps the original handlers.
		for (const [id, command] of CommandsRegistry.getCommands()) {
			if (id.startsWith('workbench.action.splitEditor') || id === 'workbench.action.toggleSplitEditorInGroup') {
				this._register(CommandsRegistry.registerCommand(id, (accessor, ...args) => {
					if (this.agents.mode === 'agents' || this.transitioning) { return; }
					return command.handler(accessor, ...args);
				}));
			}
		}
	}
	private enqueue(action: () => Promise<void>): Promise<void> {
		const result = this.queue.then(async () => {
			this.transitioning = true;
			try { await action(); } finally { this.transitioning = false; }
		});
		this.queue = result.catch(error => this.log.error('Outscaled agents view', error));
		return result;
	}
	async publish(snapshot: AgentsSnapshot): Promise<AgentsReceipt> {
		await this.enqueue(async () => {
			const next = snapshot.workspaces.find(workspace => workspace.selected)?.id;
			const switching = next !== this.selected;
			if (switching && this.selected && this.agents.mode === 'code') { this.rememberCode(); }
			this.agents.update(snapshot);
			if (switching || (this.agents.mode === 'agents' && (!this.input.value || this.input.value.isDisposed()))) {
				this.selected = next;
				const mode = next ? this.modes[next]?.mode ?? 'agents' : 'agents';
				await this.show(mode, switching);
			}
			if (snapshot.focus && snapshot.focus.workspace === next) {
				await this.show('agents');
				this.agents.owners.get(next!)?.focus(snapshot.focus.terminal);
			}
		});
		return this.agents.receipt();
	}
	setMode(mode: AgentsMode): Promise<void> { return this.enqueue(() => this.show(mode)); }
	private rememberCode(): void {
		if (!this.selected) { return; }
		const previous = this.modes[this.selected]?.code;
		const code = this.groups.saveWorkingSet(localize('agents.codeWorkingSet', "Outscaled Code: {0}", this.agents.snapshot.workspaces.find(workspace => workspace.id === this.selected)?.name ?? ''));
		if (previous) { this.groups.deleteWorkingSet(previous); }
		this.modes[this.selected] = { mode: 'code', code };
	}
	private async show(mode: AgentsMode, switching = false): Promise<void> {
		const previousMode = this.agents.mode;
		if (mode === 'agents') {
			if (previousMode === 'code' && !switching) { this.rememberCode(); }
			if (previousMode === 'code' || switching) { await this.groups.applyWorkingSet('empty', { preserveFocus: true }); }
			this.options.value = this.groups.mainPart.enforcePartOptions({ showTabs: 'none', editorActionsLocation: 'hidden', showBreadcrumbs: false });
			const owner = this.selected ? this.agents.owners.get(this.selected) : this.agents.emptyOwner;
			if (owner) {
				if (!this.input.value || this.input.value.isDisposed() || this.input.value.owner !== owner) { this.input.value = new AgentsInput(owner); }
				await this.editors.openEditor(this.input.value, { pinned: true });
			}
			await this.sidebar.openPaneComposite(agentsSidebarId, ViewContainerLocation.Sidebar);
		} else {
			this.options.clear();
			if (previousMode !== 'code' || switching) {
				await this.groups.applyWorkingSet('empty', { preserveFocus: true });
				const code = this.selected && this.modes[this.selected]?.code;
				if (code) { await this.groups.applyWorkingSet(code); }
			}
			await this.sidebar.openPaneComposite('workbench.view.explorer', ViewContainerLocation.Sidebar);
		}
		this.agents.mode = mode;
		if (this.selected) { this.modes[this.selected] = { ...this.modes[this.selected], mode }; }
		this.agents.changed();
		this.save();
	}
	private save(): void { this.storage.store(storageKey, this.modes, StorageScope.WORKSPACE, StorageTarget.MACHINE); }
}
registerSingleton(IAgentsWorkbench, AgentsWorkbench, InstantiationType.Delayed);

CommandsRegistry.registerCommand(agentsPublishCommand, async (accessor, value: unknown): Promise<AgentsReceipt> => {
	const log = accessor.get(ILogService);
	if (!isAgentsSnapshot(value)) { log.warn('Invalid Outscaled agents snapshot'); return { version: 1, ok: false, error: 'Invalid snapshot' }; }
	try { return await accessor.get(IAgentsWorkbench).publish(value); }
	catch (error) { log.error('Outscaled agents bridge', error); return { version: 1, ok: false, error: String(error) }; }
});
CommandsRegistry.registerCommand('outscaled.agents.mode', async (accessor, mode: unknown) => {
	if (mode === 'agents' || mode === 'code') { await accessor.get(IAgentsWorkbench).setMode(mode); }
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides: {
	'window.commandCenter': true,
	'workbench.layoutControl.enabled': false,
	'workbench.startupEditor': 'none',
	'terminal.integrated.commandsToSkipShell': ['outscaled.agents.new', ...Array.from({ length: 9 }, (_, index) => `outscaled.switchWorkspace${index + 1}`)]
} }]);

class AgentsStartup implements IWorkbenchContribution {
	constructor(@IAgentsWorkbench workbench: IAgentsWorkbench) { void workbench.setMode('agents'); }
}
registerWorkbenchContribution2('outscaled.agentsStartup', AgentsStartup, WorkbenchPhase.AfterRestored);

CommandsRegistry.registerCommand(agentsInspectCommand, accessor => accessor.get(IAgentsService).receipt());
