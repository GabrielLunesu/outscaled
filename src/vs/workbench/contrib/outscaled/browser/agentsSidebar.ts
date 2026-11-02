/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
// eslint-disable-next-line local/code-translation-remind
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IAgentsService } from './agentsService.js';
import { WorkspaceRow, workspaceForShortcut, workspaceRows } from './agentsSidebarModel.js';
import './media/agentsSidebar.css';

export const agentsSidebarId = 'outscaled.workspaces.container';

/** Nodes and managed hovers survive snapshot updates; only membership changes allocate them. */
class SidebarRow extends Disposable {
	readonly element = dom.$('.outscaled-workspace-row', { role: 'option', tabindex: '-1' });
	private readonly heading = dom.append(this.element, dom.$('.outscaled-workspace-heading'));
	private readonly name = dom.append(this.heading, dom.$('span.outscaled-workspace-label'));
	private readonly badge = dom.append(this.heading, dom.$('span.outscaled-workspace-badge', { 'aria-hidden': 'true' }));
	private readonly dots = dom.append(this.element, dom.$('.outscaled-workspace-dots', { 'aria-hidden': 'true' }));
	private readonly detail = dom.append(this.element, dom.$('.outscaled-workspace-detail', { 'aria-hidden': 'true' }));
	private readonly terminals = this._register(new DisposableMap<string>());
	private readonly buttons = new Map<string, HTMLButtonElement>();

	constructor(readonly id: string, agents: IAgentsService, hover: IHoverService) {
		super();
		this.element.dataset.workspaceId = id;
		this._register(dom.addDisposableListener(this.element, 'click', async event => {
			const dot = dom.isHTMLElement(event.target) ? event.target.closest<HTMLButtonElement>('button[data-terminal-id]') : null;
			if (dot) { await agents.request({ version: 1, action: 'focus', workspace: id, terminal: dot.dataset.terminalId! }); }
			else { this.element.focus(); await this.switchWorkspace(agents); }
		}));
		this._register(hover.setupManagedHover(getDefaultHoverDelegate('mouse'), this.detail, () => this.detail.textContent ?? ''));
	}
	async switchWorkspace(agents: IAgentsService): Promise<void> {
		await agents.request({ version: 1, action: 'switch', workspace: this.id });
		if (this.element.isConnected) { this.element.focus(); }
	}
	update(row: WorkspaceRow, hover: IHoverService): void {
		this.name.textContent = row.name;
		this.detail.textContent = row.detail;
		this.badge.hidden = !row.waiting;
		this.badge.textContent = String(row.waiting);
		this.element.classList.toggle('offline', !row.online);
		this.element.setAttribute('aria-selected', String(row.selected));
		this.element.setAttribute('aria-label', row.label);
		for (const [id, button] of this.buttons) {
			if (!row.dots.some(dot => dot.id === id)) { button.remove(); this.buttons.delete(id); this.terminals.deleteAndDispose(id); }
		}
		for (const [index, dot] of row.dots.entries()) {
			let button = this.buttons.get(dot.id);
			if (!button) {
				button = dom.$('button.outscaled-workspace-dot', { type: 'button', tabindex: '-1' });
				button.dataset.terminalId = dot.id;
				this.buttons.set(dot.id, button);
				const target = button;
				this.terminals.set(dot.id, hover.setupManagedHover(getDefaultHoverDelegate('mouse'), button, () => target.getAttribute('aria-label') ?? ''));
			}
			button.dataset.status = dot.status;
			button.textContent = dot.status === 'crashed' ? '×' : '';
			button.setAttribute('aria-label', dot.label);
			if (this.dots.children[index] !== button) { this.dots.insertBefore(button, this.dots.children[index] ?? null); }
		}
	}
	override dispose(): void { this.element.remove(); super.dispose(); }
}

class AgentsSidebar extends ViewPane {
	private content!: HTMLElement;
	private list!: HTMLElement;
	private empty!: HTMLElement;
	private focused: string | undefined;
	private readonly rows = this._register(new DisposableMap<string, SidebarRow>());

	constructor(options: IViewPaneOptions,
		@IKeybindingService keybindings: IKeybindingService, @IContextMenuService menus: IContextMenuService,
		@IConfigurationService configuration: IConfigurationService, @IContextKeyService context: IContextKeyService,
		@IViewDescriptorService views: IViewDescriptorService, @IInstantiationService instantiation: IInstantiationService,
		@IOpenerService opener: IOpenerService, @IThemeService theme: IThemeService, @IHoverService hover: IHoverService,
		@IAgentsService private readonly agents: IAgentsService, @ILabelService private readonly labels: ILabelService) {
		super(options, keybindings, menus, configuration, context, views, instantiation, opener, theme, hover);
	}
	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.content = dom.append(container, dom.$('.outscaled-workspaces'));
		this.list = dom.append(this.content, dom.$('.outscaled-workspace-list', { role: 'listbox', 'aria-label': localize('agents.sidebar.title', "Workspaces") }));
		this.empty = dom.append(this.content, dom.$('.outscaled-workspaces-empty', undefined, localize('agents.sidebar.empty', "No workspaces yet. Create one in a terminal with ws new <name>.")));
		dom.append(this.content, dom.$('.outscaled-workspaces-hint', undefined, isMacintosh
			? localize('agents.sidebar.macHint', "⌘1 to ⌘9 switch workspace") : localize('agents.sidebar.hint', "Ctrl+1 to Ctrl+9 switch workspace")));
		this._register(dom.addDisposableListener(this.list, 'focusin', event => {
			const row = dom.isHTMLElement(event.target) ? event.target.closest<HTMLElement>('.outscaled-workspace-row') : null;
			if (row) { this.focused = row.dataset.workspaceId; this.updateTabStops(); }
		}));
		this._register(dom.addDisposableListener(this.list, 'keydown', event => {
			const rows = this.agents.snapshot.workspaces.map(workspace => this.rows.get(workspace.id)!).filter(Boolean);
			const index = rows.findIndex(row => row.id === this.focused);
			let next: number | undefined;
			if (event.key === 'ArrowDown') { next = Math.min(index + 1, rows.length - 1); }
			else if (event.key === 'ArrowUp') { next = Math.max(0, index - 1); }
			else if (event.key === 'Home') { next = 0; }
			else if (event.key === 'End') { next = rows.length - 1; }
			else if (event.key === 'Enter' || event.key === ' ') { void rows[index]?.switchWorkspace(this.agents); }
			else { return; }
			event.preventDefault(); event.stopPropagation();
			if (next !== undefined) { rows[next]?.element.focus(); rows[next]?.element.scrollIntoView({ block: 'nearest' }); }
		}));
		this._register(this.agents.onDidChange(() => this.update()));
		this._register(this.labels.onDidChangeFormatters(() => this.update()));
		this.update();
	}
	private updateTabStops(): void {
		for (const row of this.rows.values()) { row.element.tabIndex = row.id === this.focused ? 0 : -1; }
	}
	private update(): void {
		const models = workspaceRows(this.agents.snapshot, resource => this.labels.getUriLabel(resource));
		const hadFocus = this.list.contains(dom.getActiveElement());
		for (const [id] of this.rows) { if (!models.some(row => row.id === id)) { this.rows.deleteAndDispose(id); } }
		for (const [index, model] of models.entries()) {
			let row = this.rows.get(model.id);
			if (!row) { row = new SidebarRow(model.id, this.agents, this.hoverService); this.rows.set(model.id, row); }
			row.update(model, this.hoverService);
			if (this.list.children[index] !== row.element) { this.list.insertBefore(row.element, this.list.children[index] ?? null); }
		}
		if (!this.focused || !this.rows.has(this.focused)) {
			this.focused = models.find(row => row.selected)?.id ?? models[0]?.id;
			if (hadFocus) { this.focus(); }
		}
		this.updateTabStops();
		this.empty.hidden = models.length > 0;
		this.list.hidden = !models.length;
	}
	override focus(): void {
		const row = this.focused && this.rows.get(this.focused);
		if (row) { row.element.focus(); } else { super.focus(); }
	}
	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.content.style.height = `${height}px`;
	}
}

const container = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).registerViewContainer({
	id: agentsSidebarId, title: localize2('agents.sidebar.title', "Workspaces"), icon: Codicon.folder,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [agentsSidebarId, { mergeViewWithContainerWhenSingleView: true }])
}, ViewContainerLocation.Sidebar, { isDefault: true });
Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([{
	id: 'outscaled.workspaces.sidebar', name: localize2('agents.sidebar.title', "Workspaces"), ctorDescriptor: new SyncDescriptor(AgentsSidebar),
	canToggleVisibility: false, canMoveView: false
}], container);

for (let number = 1; number <= 9; number++) {
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: `outscaled.switchWorkspace${number}`, weight: KeybindingWeight.WorkbenchContrib + 100,
		primary: KeyMod.CtrlCmd | (KeyCode.Digit1 + number - 1),
		handler: async accessor => {
			const agents = accessor.get(IAgentsService);
			const workspace = workspaceForShortcut(agents.snapshot, number);
			if (workspace) { await agents.request({ version: 1, action: 'switch', workspace }); }
		}
	});
}
