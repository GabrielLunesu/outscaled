/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { AgentPane, AgentsMode, AgentsReceipt, AgentsRequest, agentsRequestCommand, AgentsSnapshot, isAgentsReceipt } from '../common/agentsBridge.js';
import { AgentsLayout, layoutTerminals, presetLayout, sameLayoutStructure, splitSizes } from '../common/agentsLayout.js';
import { ITerminalConfigurationService, ITerminalEditorService, ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../terminal/browser/terminal.js';
import { registerAgentTerminalHost } from './agentsTerminalHost.js';
import { agentRuntimeLabel } from './agentsBackgroundModel.js';
import { agentStatusLabel } from './agentsSidebarModel.js';
import { Sash, Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { agentsModeActive, createPaneContext } from './agentsPaneContext.js';
import { openContextMenu } from '../../terminal/browser/terminalContextMenu.js';

export const IAgentsService = createDecorator<IAgentsService>('outscaledAgentsService');
export interface IAgentsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly snapshot: AgentsSnapshot;
	mode: AgentsMode;
	readonly owners: ReadonlyMap<string, WorkspaceTerminals>;
	readonly emptyOwner: WorkspaceTerminals;
	update(snapshot: AgentsSnapshot): void;
	request(request: AgentsRequest): Promise<void>;
	receipt(): AgentsReceipt;
	changed(): void;
}

/** A pane is registered with the native terminal host, but its editor input is never opened. */
class AgentTerminal extends Disposable {
	readonly element = dom.$('section.outscaled-agent-pane');
	readonly body: HTMLElement;
	readonly instance: ITerminalInstance;
	private readonly dot: HTMLElement;
	private readonly name: HTMLElement;
	private readonly runtime: HTMLElement;
	private cancelContextMenu = false;

	constructor(pane: AgentPane, instances: ITerminalInstanceService, editors: ITerminalEditorService,
		terminals: ITerminalService, menus: IMenuService, context: IContextKeyService, contextMenus: IContextMenuService,
		configuration: ITerminalConfigurationService, focused: () => void, disposed: () => void, reveal: () => Promise<void>) {
		super();
		this.instance = this._register(instances.createInstance({ ...pane.launch!, name: pane.name, isTransient: true, waitOnExit: true, forceShellIntegration: false }, TerminalLocation.Editor));
		// resolveResource registers focus/disposal/capability routing without revealing an editor.
		editors.resolveResource(this.instance);
		this._register(registerAgentTerminalHost(this.instance, reveal));
		this._register({ dispose: () => editors.detachInstance(this.instance) });
		this.element.dataset.terminalId = pane.id;
		this.element.dataset.instanceId = String(this.instance.instanceId);
		this.element.setAttribute('aria-label', pane.name);
		const header = dom.append(this.element, dom.$('header.outscaled-agent-header'));
		this.dot = dom.append(header, dom.$('span.outscaled-status-dot', { role: 'img' }));
		this.name = dom.append(header, dom.$('span.outscaled-agent-name'));
		this.runtime = dom.append(header, dom.$('span.outscaled-runtime-badge'));
		const scoped = createPaneContext(this.element, header, pane.id, context, menus, contextMenus, this._register(new DisposableStore()));
		this.instance.setParentContextKeyService(scoped);
		this.body = dom.append(this.element, dom.$('.terminal-overflow-guard.terminal-editor.outscaled-agent-body'));
		const menu = this._register(menus.createMenu(MenuId.TerminalInstanceContext, scoped));
		this._register(this.instance.onDidFocus(() => { terminals.setActiveInstance(this.instance); focused(); }));
		this._register(dom.addDisposableListener(this.element, 'focusin', () => { terminals.setActiveInstance(this.instance); focused(); }));
		this._register(this.instance.onDisposed(disposed));
		this._register(dom.addDisposableListener(this.element, 'mousedown', async event => {
			terminals.setActiveInstance(this.instance);
			if (dom.isHTMLElement(event.target) && event.target.closest('.outscaled-agent-header')) { this.instance.focus(true); }
			const result = await this.instance.handleMouseEvent(event, menu);
			this.cancelContextMenu = typeof result === 'object' && !!result.cancelContextMenu;
		}));
		this._register(dom.addDisposableListener(this.element, 'contextmenu', event => {
			const behavior = configuration.config.rightClickBehavior;
			if (behavior === 'nothing' && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); }
			else if (!this.cancelContextMenu && behavior !== 'copyPaste' && behavior !== 'paste') {
				openContextMenu(dom.getWindow(this.element), event, this.instance, menu, contextMenus);
				event.preventDefault(); event.stopImmediatePropagation();
			}
			this.cancelContextMenu = false;
		}));
		this.update(pane);
	}
	update(pane: AgentPane): void {
		this.element.dataset.status = pane.status;
		this.name.textContent = pane.name;
		this.runtime.textContent = agentRuntimeLabel(pane.runtime);
		this.dot.textContent = pane.status === 'crashed' ? '×' : '';
		this.dot.setAttribute('aria-label', agentStatusLabel(pane.status));
	}
	layout(): void {
		if (this.body.clientWidth && this.body.clientHeight) {
			if (this.instance.domElement?.parentElement !== this.body) { this.instance.attachToElement(this.body); }
			this.instance.layout({ width: this.body.clientWidth, height: this.body.clientHeight });
		}
	}
	override dispose(): void { this.element.remove(); super.dispose(); }
}

/** Lifetime is independent of editors, modes and root switches. */
export class WorkspaceTerminals extends Disposable {
	readonly element = dom.$('.outscaled-agents-grid');
	readonly panes = new Map<string, AgentTerminal>();
	private readonly owned = this._register(new DisposableMap<string, AgentTerminal>());
	private readonly closed = new Set<string>();
	private readonly placeholders = new Map<string, HTMLElement>();
	private topology = '';
	private renderedTree: AgentsLayout | undefined;
	private resizing = false;
	private readonly rendered = this._register(new DisposableStore());
	private readonly layoutUpdates: (() => void)[] = [];
	active: string | undefined;
	visible = false;
	constructor(private readonly instances: ITerminalInstanceService, private readonly editors: ITerminalEditorService,
		private readonly terminals: ITerminalService, private readonly menus: IMenuService, private readonly context: IContextKeyService,
		private readonly contextMenus: IContextMenuService, private readonly configuration: ITerminalConfigurationService, private readonly reveal: (terminal: string) => Promise<void>,
		private readonly resize: (tree: AgentsLayout) => void) { super(); }
	update(panes: AgentPane[], tree: AgentsLayout): void {
		const inGrid = new Set(layoutTerminals(tree));
		for (const [id] of this.panes) {
			if (!panes.some(pane => pane.id === id)) { this.panes.delete(id); this.owned.deleteAndDispose(id); this.topology = ''; }
		}
		for (const pane of panes) {
			let terminal = this.panes.get(pane.id);
			if (!terminal && pane.launch && inGrid.has(pane.id) && !this.closed.has(pane.id)) {
				terminal = new AgentTerminal(pane, this.instances, this.editors, this.terminals, this.menus, this.context, this.contextMenus, this.configuration,
					() => { this.active = pane.id; }, () => { this.closed.add(pane.id); this.panes.delete(pane.id); this.owned.deleteAndDispose(pane.id); this.topology = ''; }, () => this.reveal(pane.id));
				this.owned.set(pane.id, terminal);
				this.panes.set(pane.id, terminal);
				this.topology = '';
			}
			terminal?.update(pane);
		}
		const topology = JSON.stringify({ placeholders: panes.filter(pane => inGrid.has(pane.id) && !this.panes.has(pane.id)).map(pane => [pane.id, pane.name, pane.runtime, pane.status]) });
		if (topology !== this.topology || !this.renderedTree || !sameLayoutStructure(this.renderedTree, tree)) {
			this.topology = topology;
			const restoreFocus = this.element.contains(dom.getActiveElement());
			this.rendered.clear(); this.layoutUpdates.length = 0;
			this.placeholders.clear();
			this.resizing = false;
			const renderedTree = this.renderedTree = structuredClone(tree);
			const render = (node: AgentsLayout): HTMLElement => {
				if (node.type === 'pane') {
					const live = node.terminal && this.panes.get(node.terminal);
					if (live) { return live.element; }
					const pane = panes.find(pane => pane.id === node.terminal && !this.closed.has(pane.id));
					if (!pane) { return dom.$('.outscaled-empty-pane'); }
					// A crashed/exited daemon terminal still has a header after a reload,
					// even though it cannot start an attach client.
					const element = dom.$('section.outscaled-agent-pane', { 'aria-label': pane.name, tabindex: '0' });
					this.placeholders.set(pane.id, element);
					element.dataset.terminalId = pane.id;
					element.dataset.status = pane.status;
					const header = dom.append(element, dom.$('header.outscaled-agent-header'));
					dom.append(header, dom.$('span.outscaled-status-dot', { role: 'img', 'aria-label': agentStatusLabel(pane.status) }, pane.status === 'crashed' ? '×' : ''));
					dom.append(header, dom.$('span.outscaled-agent-name', undefined, pane.name));
					dom.append(header, dom.$('span.outscaled-runtime-badge', undefined, agentRuntimeLabel(pane.runtime)));
					createPaneContext(element, header, pane.id, this.context, this.menus, this.contextMenus, this.rendered);
					this.rendered.add(dom.addDisposableListener(element, 'focusin', () => { this.active = pane.id; }));
					dom.append(element, dom.$('.outscaled-agent-body', undefined, localize('agents.notRunning', "This terminal is not running.")));
					return element;
				}
				const element = dom.$('.outscaled-agents-split');
				element.dataset.direction = node.direction;
				const children = node.children.map(render);
				element.append(...children);
				const horizontal = node.direction === 'right';
				const applySizes = () => { splitSizes(node).forEach((size, index) => { children[index].style.flex = `0 0 calc((100% - ${(children.length - 1) * 8}px) * ${size})`; }); };
				applySizes();
				this.layoutUpdates.unshift(applySizes);
				for (let index = 0; index < children.length - 1; index++) {
					const boundary = () => horizontal ? children[index].offsetLeft + children[index].offsetWidth + 4 : children[index].offsetTop + children[index].offsetHeight + 4;
					const sash = this.rendered.add(horizontal
						? new Sash(element, { getVerticalSashLeft: boundary, getVerticalSashHeight: () => element.clientHeight }, { orientation: Orientation.VERTICAL })
						: new Sash(element, { getHorizontalSashTop: boundary, getHorizontalSashWidth: () => element.clientWidth }, { orientation: Orientation.HORIZONTAL }));
					this.layoutUpdates.push(() => sash.layout());
					let sizes: number[] = [];
					let available = 0;
					this.rendered.add(sash.onDidStart(() => {
						this.resizing = true;
						sizes = splitSizes(node);
						available = (horizontal ? element.clientWidth : element.clientHeight) - (children.length - 1) * 8;
					}));
					this.rendered.add(sash.onDidChange(event => {
						if (available <= 0) { return; }
						const delta = (horizontal ? event.currentX - event.startX : event.currentY - event.startY) / available;
						const total = sizes[index] + sizes[index + 1];
						const minimum = Math.min(80 / available, total / 2);
						const first = Math.max(minimum, Math.min(total - minimum, sizes[index] + delta));
						node.sizes = [...sizes]; node.sizes[index] = first; node.sizes[index + 1] = total - first;
						this.layout();
					}));
					this.rendered.add(sash.onDidEnd(() => { this.resizing = false; this.resize(structuredClone(renderedTree)); }));
					this.rendered.add(sash.onDidReset(() => { this.resizing = false; delete node.sizes; this.layout(); this.resize(structuredClone(renderedTree)); }));
				}
				return element;
			};
			this.element.replaceChildren(render(renderedTree));
			if (restoreFocus && inGrid.size) { this.focus(); }
			if (!inGrid.size) { this.active = undefined; this.element.textContent = localize('agents.empty', "Choose New agents to open a terminal grid."); }
		} else if (!this.resizing) {
			// Apply acknowledgements without replacing sashes: another drag may already be starting.
			const sizes = (target: AgentsLayout, source: AgentsLayout): void => {
				if (target.type !== 'split' || source.type !== 'split') { return; }
				if (source.sizes) { target.sizes = [...source.sizes]; } else { delete target.sizes; }
				target.children.forEach((child, index) => sizes(child, source.children[index]));
			};
			sizes(this.renderedTree, tree);
		}
		this.setVisible(this.visible);
	}
	layout(): void { for (const layout of this.layoutUpdates) { layout(); } for (const pane of this.panes.values()) { if (this.element.contains(pane.element)) { pane.layout(); } } }
	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) { this.layout(); }
		for (const pane of this.panes.values()) { pane.instance.setVisible(visible && this.element.contains(pane.element)); }
	}
	/** Pick the closest visible pane in screen space, including non-running placeholders. */
	nearest(id: string): string | undefined {
		const panes = [...this.panes.values()].map(pane => pane.element).concat([...this.placeholders.values()]).filter(pane => this.element.contains(pane));
		const origin = panes.find(pane => pane.dataset.terminalId === id)?.getBoundingClientRect();
		if (!origin) { return undefined; }
		let nearest: string | undefined;
		let distance = Infinity;
		for (const pane of panes) {
			if (pane.dataset.terminalId === id) { continue; }
			const box = pane.getBoundingClientRect();
			const next = Math.hypot(box.x + box.width / 2 - origin.x - origin.width / 2, box.y + box.height / 2 - origin.y - origin.height / 2);
			if (next < distance) { distance = next; nearest = pane.dataset.terminalId; }
		}
		return nearest;
	}

	focus(id = this.active): void {
		if (id && !this.panes.has(id)) {
			const placeholder = this.placeholders.get(id);
			if (placeholder) { this.active = id; placeholder.focus(); return; }
		}
		const candidate = id && this.panes.get(id);
		const pane = candidate && this.element.contains(candidate.element) ? candidate : [...this.panes.values()].find(pane => this.element.contains(pane.element));
		if (pane) {
			this.active = pane.element.dataset.terminalId;
			pane.instance.focus(true);
			if (!pane.instance.xterm) { void this.focusWhenReady(pane); }
		}
	}
	private async focusWhenReady(pane: AgentTerminal): Promise<void> {
		await pane.instance.xtermReadyPromise;
		if (this.visible && this.active === pane.element.dataset.terminalId && this.element.contains(pane.element)) { pane.layout(); pane.instance.focus(true); }
	}
	override dispose(): void { this.element.remove(); super.dispose(); }
}

class AgentsService extends Disposable implements IAgentsService {
	declare readonly _serviceBrand: undefined;
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChange = this.changes.event;
	snapshot: AgentsSnapshot = { version: 1, workspaces: [] };
	mode: AgentsMode = 'agents';
	readonly owners = new Map<string, WorkspaceTerminals>();
	readonly emptyOwner: WorkspaceTerminals;
	private readonly owned = this._register(new DisposableMap<string, WorkspaceTerminals>());
	private readonly modeContext: IContextKey<boolean>;
	constructor(@ITerminalInstanceService private readonly instances: ITerminalInstanceService,
		@ITerminalEditorService private readonly editors: ITerminalEditorService, @ITerminalService private readonly terminals: ITerminalService,
		@IMenuService private readonly menus: IMenuService, @IContextKeyService private readonly context: IContextKeyService,
		@IContextMenuService private readonly contextMenus: IContextMenuService, @ITerminalConfigurationService private readonly configuration: ITerminalConfigurationService,
		@ICommandService private readonly commands: ICommandService, @ILogService private readonly log: ILogService) {
		super();
		this.modeContext = agentsModeActive.bindTo(context);
		this._register({ dispose: () => this.modeContext.reset() });
		this.emptyOwner = this._register(new WorkspaceTerminals(instances, editors, terminals, menus, context, contextMenus, configuration, async () => {}, () => {}));
		this.emptyOwner.update([], presetLayout('single', []));
	}
	update(snapshot: AgentsSnapshot): void {
		this.snapshot = snapshot;
		for (const workspace of snapshot.workspaces) {
			let owner = this.owners.get(workspace.id);
			if (!owner) {
				owner = new WorkspaceTerminals(this.instances, this.editors, this.terminals, this.menus, this.context, this.contextMenus, this.configuration, terminal => this.request({ version: 1, action: 'focus', workspace: workspace.id, terminal }),
					tree => { void this.request({ version: 1, action: 'resize', workspace: workspace.id, layout: tree }); });
				this.owned.set(workspace.id, owner); this.owners.set(workspace.id, owner);
			}
			owner.update(workspace.terminals, workspace.layout);
		}
		// Unavailable servers retain owners. Only an authoritative daemon list removes a terminal.
		this.changed();
	}
	changed(): void { this.modeContext.set(this.mode === 'agents'); this.changes.fire(); }
	async request(request: AgentsRequest): Promise<void> {
		try {
			const result = await this.commands.executeCommand<unknown>(agentsRequestCommand, request);
			if (!isAgentsReceipt(result) || !result.ok) { this.log.warn('Outscaled agents bridge request failed', isAgentsReceipt(result) ? result.error : 'Invalid receipt'); }
		} catch (error) { this.log.warn('Outscaled agents bridge request failed', error); }
	}
	receipt(): AgentsReceipt {
		return { version: 1, ok: true, panes: [...this.owners].flatMap(([workspace, owner]) => [...owner.panes].map(([terminal, pane]) =>
			({ workspace, terminal, processId: pane.instance.processId, visible: owner.visible && owner.element.contains(pane.element) }))) };
	}
}
registerSingleton(IAgentsService, AgentsService, InstantiationType.Delayed);
