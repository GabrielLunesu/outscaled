/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeViewSwitcher } from './agentsCode.js';
import { AgentsChangesDrawer } from './agentsChanges.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerTitleControl } from '../../../browser/parts/titlebar/titleControlRegistry.js';
import { AgentsWaitingList } from './agentsWaiting.js';
import { waitingAgents } from './agentsWaitingModel.js';
import { IAgentsService } from './agentsService.js';

class AgentsTitleControl extends Disposable {
	readonly element = dom.$('.outscaled-title-controls');
	constructor(@IAgentsService agents: IAgentsService, @ICommandService commands: ICommandService, @IContextViewService context: IContextViewService, @IInstantiationService instantiation: IInstantiationService) {
		super();
		const name = dom.append(this.element, dom.$('strong.outscaled-workspace-name'));
		const branch = dom.append(this.element, dom.$('span.outscaled-workspace-branch'));
		const button = (parent: HTMLElement, label: string, run: () => void) => {
			const control = dom.append(parent, dom.$<HTMLButtonElement>('button', { type: 'button' }, label));
			this._register(dom.addDisposableListener(control, 'click', run));
			return control;
		};
		button(this.element, localize('agents.new', "New agents"), () => { void commands.executeCommand('outscaled.agents.new'); });
		let closeList: (() => void) | undefined;
		this._register(toDisposable(() => closeList?.()));
		const needsYou = button(this.element, '', () => {
			if (closeList) { closeList(); return; }
			let list: AgentsWaitingList | undefined;
			const view = context.showContextView({ getAnchor: () => needsYou,
				render: container => {
					const store = new DisposableStore();
					list = store.add(new AgentsWaitingList(agents, commands, () => closeList?.()));
					container.append(list.element);
					store.add(dom.addDisposableListener(dom.getWindow(container).document, 'mousedown', event => {
						if (dom.isHTMLElement(event.target) && !list?.element.contains(event.target) && !needsYou.contains(event.target)) { closeList?.(); }
					}, true));
					return store;
				}, focus: () => list?.focus(), onHide: () => {
					const restoreFocus = list?.element.contains(dom.getActiveElement());
					closeList = undefined; needsYou.setAttribute('aria-expanded', 'false');
					if (restoreFocus) { needsYou.focus(); }
				}
			});
			closeList = () => view.close(); needsYou.setAttribute('aria-expanded', 'true');
		});
		needsYou.setAttribute('aria-haspopup', 'dialog');
		needsYou.classList.add('outscaled-needs-you');
		const modes = dom.append(this.element, dom.$('.outscaled-mode-switch', { role: 'group', 'aria-label': localize('agents.mode', "View Mode") }));
		const home = button(modes, localize('agents.home', "Agents"), () => { void commands.executeCommand('outscaled.agents.mode', 'agents'); });
		const code = button(modes, localize('agents.code', "Code"), () => { void commands.executeCommand('outscaled.agents.mode', 'code'); });
		const viewSwitcher = this._register(instantiation.createInstance(CodeViewSwitcher));
		this.element.append(viewSwitcher.element);
		const drawer = this._register(new MutableDisposable<AgentsChangesDrawer>());
		let previousFocus: HTMLElement | undefined;
		let closeDrawer: (() => void) | undefined;
		const changes = button(this.element, localize('agents.changes', "Changes"), () => {
			if (drawer.value) { closeDrawer?.(); return; }
			const workspace = agents.snapshot.workspaces.find(workspace => workspace.selected);
			if (!workspace) { return; }
			const restore = previousFocus ?? dom.getActiveElement();
			const close = (restoreFocus = true) => {
				drawer.clear(); closeDrawer = undefined; changes.setAttribute('aria-expanded', 'false');
				if (restoreFocus && dom.isHTMLElement(restore) && restore.isConnected) { restore.focus(); }
			};
			closeDrawer = close;
			drawer.value = instantiation.createInstance(AgentsChangesDrawer, workspace.id, close);
			changes.setAttribute('aria-expanded', 'true'); drawer.value?.focus();
		});
		changes.classList.add('outscaled-changes-button'); changes.setAttribute('aria-haspopup', 'dialog');
		this._register(dom.addDisposableListener(changes, 'mousedown', () => { if (drawer.value) { return; } const active = dom.getActiveElement(); previousFocus = dom.isHTMLElement(active) ? active : undefined; }));
		this._register(dom.addDisposableListener(changes, 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') { previousFocus = undefined; } }));
		const update = () => {
			const workspace = agents.snapshot.workspaces.find(workspace => workspace.selected);
			name.textContent = workspace?.name ?? localize('agents.product', "Outscaled");
			branch.textContent = workspace?.branch ?? '';
			branch.hidden = !workspace?.branch;
			const changed = workspace?.changes?.files.length ?? 0;
			changes.textContent = changed ? localize('agents.changesCount', "Changes {0}", changed) : localize('agents.changes', "Changes");
			changes.classList.toggle('quiet', !changed); changes.disabled = !workspace;
			const count = waitingAgents(agents.snapshot).length;
			needsYou.hidden = !count;
			needsYou.textContent = localize('agents.waiting', "{0} need you", count);
			home.setAttribute('aria-pressed', String(agents.mode === 'agents'));
			code.setAttribute('aria-pressed', String(agents.mode === 'code'));
		};
		this._register(agents.onDidChange(update)); update();
	}
}
registerTitleControl(new SyncDescriptor(AgentsTitleControl));
