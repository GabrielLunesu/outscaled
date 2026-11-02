/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerTitleControl } from '../../../browser/parts/titlebar/titleControlRegistry.js';
import { IAgentsService } from './agentsService.js';

class AgentsTitleControl extends Disposable {
	readonly element = dom.$('.outscaled-title-controls');
	constructor(@IAgentsService agents: IAgentsService, @ICommandService commands: ICommandService) {
		super();
		const name = dom.append(this.element, dom.$('strong.outscaled-workspace-name'));
		const branch = dom.append(this.element, dom.$('span.outscaled-workspace-branch'));
		const button = (parent: HTMLElement, label: string, run: () => void) => {
			const control = dom.append(parent, dom.$('button', { type: 'button' }, label));
			this._register(dom.addDisposableListener(control, 'click', run));
			return control;
		};
		button(this.element, localize('agents.new', "New agents"), () => { void agents.request({ version: 1, action: 'newAgents' }); });
		const needsYou = button(this.element, '', () => {
			for (const workspace of agents.snapshot.workspaces) {
				const waiting = workspace.terminals.find(terminal => terminal.status === 'needs_input');
				if (waiting) { void agents.request({ version: 1, action: 'focus', workspace: workspace.id, terminal: waiting.id }); break; }
			}
		});
		needsYou.classList.add('outscaled-needs-you');
		const modes = dom.append(this.element, dom.$('.outscaled-mode-switch', { role: 'group', 'aria-label': localize('agents.mode', "View Mode") }));
		const home = button(modes, localize('agents.home', "Agents"), () => { void commands.executeCommand('outscaled.agents.mode', 'agents'); });
		const code = button(modes, localize('agents.code', "Code"), () => { void commands.executeCommand('outscaled.agents.mode', 'code'); });
		const update = () => {
			const workspace = agents.snapshot.workspaces.find(workspace => workspace.selected);
			name.textContent = workspace?.name ?? localize('agents.product', "Outscaled");
			branch.textContent = workspace?.branch ?? '';
			branch.hidden = !workspace?.branch;
			const count = agents.snapshot.workspaces.reduce((sum, workspace) => sum + workspace.terminals.filter(terminal => terminal.status === 'needs_input').length, 0);
			needsYou.hidden = !count;
			needsYou.textContent = localize('agents.waiting', "{0} need you", count);
			home.setAttribute('aria-pressed', String(agents.mode === 'agents'));
			code.setAttribute('aria-pressed', String(agents.mode === 'code'));
		};
		this._register(agents.onDidChange(update)); update();
	}
}
registerTitleControl(new SyncDescriptor(AgentsTitleControl));
