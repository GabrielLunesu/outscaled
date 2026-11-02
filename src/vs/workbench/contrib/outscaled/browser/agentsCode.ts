/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
// eslint-disable-next-line local/code-translation-remind
import { localize, localize2 } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IAgentsService } from './agentsService.js';
import { agentStatusLabel } from './agentsSidebarModel.js';
import { codeRailAgents, codeViews } from './agentsCodeModel.js';
import './media/agentsCode.css';

export const agentsRailId = 'outscaled.agents.rail';

/** Overlay only the native sidebar title slot, leaving its content/layout under native ownership. */
export class CodeViewSwitcher extends Disposable {
	readonly element = dom.$('span.outscaled-code-switcher-fallback');
	constructor(@IAgentsService agents: IAgentsService, @IWorkbenchLayoutService layout: IWorkbenchLayoutService,
		@IPaneCompositePartService panes: IPaneCompositePartService, @IKeybindingService bindings: IKeybindingService, @IHoverService hover: IHoverService) {
		super();
		const element = dom.$('nav.outscaled-code-switcher', { 'aria-label': localize('code.views', "Code Views") });
		this._register(toDisposable(() => element.remove()));
		const buttons = codeViews.map(view => {
			const button = dom.append(element, dom.$('button', { type: 'button', 'aria-label': view.label }));
			dom.append(button, dom.$(`span.codicon.codicon-${view.icon.id}`, { 'aria-hidden': 'true' }));
			this._register(hover.setupManagedHover(getDefaultHoverDelegate('mouse'), button, () => {
				const shortcut = bindings.lookupKeybinding(view.command)?.getLabel();
				return shortcut ? localize('code.viewShortcut', "{0} ({1})", view.label, shortcut) : view.label;
			}));
			this._register(dom.addDisposableListener(button, 'click', () => { void panes.openPaneComposite(view.id, ViewContainerLocation.Sidebar, true); }));
			return button;
		});
		const update = () => {
			const parent = layout.getContainer(mainWindow, Parts.SIDEBAR_PART);
			const inSidebar = !!parent && layout.isVisible(Parts.SIDEBAR_PART);
			const host = inSidebar ? parent : this.element;
			if (element.parentElement !== host) { host.append(element); }
			element.hidden = agents.mode !== 'code';
			this.element.hidden = agents.mode !== 'code' || inSidebar;
			buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === codeViews[index].id)));
		};
		this._register(layout.onDidChangePartVisibility(update)); this._register(layout.onDidLayoutMainContainer(update));
		this._register(agents.onDidChange(update)); this._register(panes.onDidPaneCompositeOpen(update)); this._register(panes.onDidPaneCompositeClose(update)); update();
	}
}

class RailRow extends Disposable {
	readonly element = dom.$('button.outscaled-rail-agent', { type: 'button' });
	private readonly dot = dom.append(this.element, dom.$('span.outscaled-status-dot', { 'aria-hidden': 'true' }));
	private readonly text = dom.append(this.element, dom.$('span'));
	private readonly name = dom.append(this.text, dom.$('strong'));
	private readonly status = dom.append(this.text, dom.$('small'));
	constructor(activate: () => void, hover: IHoverService) {
		super();
		this._register(toDisposable(() => this.element.remove()));
		this._register(dom.addDisposableListener(this.element, 'click', activate));
		this._register(hover.setupManagedHover(getDefaultHoverDelegate('mouse'), this.element, () => this.element.getAttribute('aria-label') ?? ''));
	}
	update(id: string, terminal: string | undefined, name: string, runtime: string, status: string, label: string): void {
		this.element.dataset.agentId = id;
		if (terminal) { this.element.dataset.terminalId = terminal; } else { delete this.element.dataset.terminalId; }
		this.name.textContent = name; this.status.textContent = label; this.element.dataset.status = status;
		this.dot.textContent = status === 'crashed' ? '×' : '';
		this.element.setAttribute('aria-label', localize('code.agentLabel', "{0} · {1} · {2}", name, runtime, label));
	}
}

/** The native secondary sidebar reserves space and lays out editors when this rail opens. */
class AgentsRail extends ViewPane {
	private list!: HTMLElement;
	private empty!: HTMLElement;
	private readonly rows = this._register(new DisposableMap<string, RailRow>());
	constructor(options: IViewPaneOptions,
		@IKeybindingService bindings: IKeybindingService, @IContextMenuService menus: IContextMenuService,
		@IConfigurationService configuration: IConfigurationService, @IContextKeyService context: IContextKeyService,
		@IViewDescriptorService views: IViewDescriptorService, @IInstantiationService instantiation: IInstantiationService,
		@IOpenerService opener: IOpenerService, @IThemeService theme: IThemeService, @IHoverService hover: IHoverService,
		@IAgentsService private readonly agents: IAgentsService, @ICommandService private readonly commands: ICommandService) {
		super(options, bindings, menus, configuration, context, views, instantiation, opener, theme, hover);
	}
	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.list = dom.append(container, dom.$('nav.outscaled-agents-rail', { 'aria-label': localize('code.workspaceAgents', "Workspace Agents") }));
		this.empty = dom.append(this.list, dom.$('p', undefined, localize('code.noAgents', "No agents in this workspace.")));
		this._register(this.agents.onDidChange(() => this.update())); this.update();
	}
	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.list.style.height = `${height}px`;
	}
	private open(id: string): void {
		const workspace = this.agents.snapshot.workspaces.find(workspace => workspace.selected);
		const agent = codeRailAgents(workspace).find(agent => agent.id === id);
		if (!workspace || !agent) { return; }
		if (agent.terminal) { void this.agents.request({ version: 1, action: 'focus', workspace: workspace.id, terminal: agent.terminal }); }
		else { void this.commands.executeCommand('outscaled.agents.backgroundCard', workspace.id, agent.id); }
	}
	private update(): void {
		const workspace = this.agents.snapshot.workspaces.find(workspace => workspace.selected);
		const terminals = codeRailAgents(workspace);
		const key = (id: string) => `${workspace!.id}\0${id}`;
		for (const [id] of this.rows) { if (!terminals.some(terminal => key(terminal.id) === id)) { this.rows.deleteAndDispose(id); } }
		for (const terminal of terminals) {
			let row = this.rows.get(key(terminal.id));
			if (!row) { row = new RailRow(() => this.open(terminal.id), this.hoverService); this.rows.set(key(terminal.id), row); this.list.append(row.element); }
			row.update(terminal.id, terminal.terminal, terminal.name, terminal.runtime, terminal.status, agentStatusLabel(terminal.status));
		}
		this.empty.hidden = !!terminals.length;
	}
}
const container = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).registerViewContainer({
	id: agentsRailId, title: localize2('code.agents', "Agents"), icon: Codicon.terminal,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [agentsRailId, { mergeViewWithContainerWhenSingleView: true }])
}, ViewContainerLocation.AuxiliaryBar);
Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([{
	id: 'outscaled.agents.rail.view', name: localize2('code.agents', "Agents"), ctorDescriptor: new SyncDescriptor(AgentsRail), canToggleVisibility: false, canMoveView: false
}], container);
