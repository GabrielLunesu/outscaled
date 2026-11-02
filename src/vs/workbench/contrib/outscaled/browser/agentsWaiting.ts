/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
// eslint-disable-next-line local/code-translation-remind
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { agentsRequestCommand, isAgentsReceipt } from '../common/agentsBridge.js';
import { IAgentsService } from './agentsService.js';
import { nextWaitingAgent, WaitingAgent, waitingAgents } from './agentsWaitingModel.js';
import './media/agentsWaiting.css';

/** Rows survive live snapshots so an answer in flight cannot be submitted twice. */
class WaitingRow extends Disposable {
	readonly element = dom.$('section.outscaled-waiting-row', { tabindex: '0' });
	private readonly heading = dom.append(this.element, dom.$('header'));
	private readonly name = dom.append(this.heading, dom.$('strong'));
	private readonly workspace = dom.append(this.heading, dom.$('span'));
	private readonly request = dom.append(this.element, dom.$('p.outscaled-waiting-request'));
	private readonly actions = dom.append(this.element, dom.$('.outscaled-waiting-actions'));
	private readonly allow: HTMLButtonElement;
	private readonly deny: HTMLButtonElement;
	private readonly jump: HTMLButtonElement;
	private readonly error = dom.append(this.element, dom.$('p', { role: 'status' }));
	private busy = false;
	model: WaitingAgent;
	constructor(model: WaitingAgent, private readonly agents: IAgentsService, private readonly commands: ICommandService, private readonly close: () => void) {
		super(); this.model = model;
		this.allow = this.button(localize('waiting.allow', "Allow Once"), () => this.answer('allow_once'));
		this.deny = this.button(localize('waiting.deny', "Deny"), () => this.answer('deny'));
		this.jump = this.button(localize('waiting.jump', "Jump"), async () => {
			this.close();
			await this.agents.request({ version: 1, action: 'focus', workspace: this.model.workspace.id, terminal: this.model.pane.id });
		});
		this._register(dom.addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Enter' && event.target === this.element) { this.jump.click(); event.preventDefault(); }
		}));
		this.update(model);
	}
	private button(label: string, action: () => Promise<void>): HTMLButtonElement {
		const button = dom.append(this.actions, dom.$<HTMLButtonElement>('button', { type: 'button' }, label));
		this._register(dom.addDisposableListener(button, 'click', () => { if (!button.disabled) { void action(); } }));
		return button;
	}
	private async answer(answer: 'allow_once' | 'deny'): Promise<void> {
		if (this.busy) { return; }
		this.busy = true; this.error.textContent = ''; this.update(this.model);
		try {
			const receipt = await this.commands.executeCommand<unknown>(agentsRequestCommand, {
				version: 1, action: 'answer', workspace: this.model.workspace.id, terminal: this.model.pane.id, answer
			});
			if (!isAgentsReceipt(receipt) || !receipt.ok) { throw new Error(isAgentsReceipt(receipt) ? receipt.error : localize('waiting.failed', "Could not answer the agent.")); }
			if (receipt.jumped) { this.close(); }
		} catch (error) { this.error.textContent = String(error); }
		finally { this.busy = false; this.update(this.model); }
	}
	update(model: WaitingAgent): void {
		this.model = model; this.element.dataset.terminalId = model.pane.id; this.element.dataset.workspaceId = model.workspace.id;
		this.name.textContent = model.pane.name;
		this.workspace.textContent = localize('waiting.workspace', "in {0} · {1}", model.workspace.name, model.workspace.server);
		this.request.textContent = model.text;
		this.element.setAttribute('aria-label', localize('waiting.row', "{0}, {1}. {2}", model.pane.name, model.workspace.name, model.text));
		for (const button of [this.allow, this.deny]) { button.hidden = !model.canAnswer; button.disabled = this.busy || !model.workspace.online; }
	}
	tabStops(): HTMLElement[] { return [this.element, this.allow, this.deny, this.jump].filter(control => !control.hidden && !(dom.isHTMLButtonElement(control) && control.disabled)); }
	override dispose(): void { this.element.remove(); super.dispose(); }
}

/** An anchored, keyboard-accessible list spanning all workspaces, with oldest requests first. */
export class AgentsWaitingList extends Disposable {
	readonly element = dom.$('.outscaled-waiting-list', { role: 'dialog', 'aria-label': localize('waiting.title', "Waiting on You") });
	private readonly heading = dom.append(this.element, dom.$('h3', undefined, localize('waiting.title', "Waiting on You")));
	private readonly list = dom.append(this.element, dom.$('div'));
	private readonly rows = this._register(new DisposableMap<string, WaitingRow>());
	constructor(private readonly agents: IAgentsService, private readonly commands: ICommandService, private readonly close: () => void) {
		super();
		this._register(toDisposable(() => this.element.remove()));
		this._register(agents.onDidChange(() => this.update()));
		this._register(dom.addDisposableListener(this.element, 'keydown', event => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') { this.close(); return; }
			if (event.key === 'Escape') { this.close(); event.preventDefault(); }
			else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
				const rows = [...this.list.children] as HTMLElement[];
				const index = rows.findIndex(row => row.contains(dom.getActiveElement()));
				const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowUp' ? rows.length - 1 : 1)) % rows.length;
				rows[next]?.focus(); event.preventDefault();
			} else if (event.key === 'Tab') {
				const controls = waitingAgents(this.agents.snapshot).flatMap(model => this.rows.get(model.key)?.tabStops() ?? []);
				if (event.shiftKey && event.target === controls[0]) { controls.at(-1)?.focus(); event.preventDefault(); }
				else if (!event.shiftKey && event.target === controls.at(-1)) { controls[0]?.focus(); event.preventDefault(); }
			}
			event.stopPropagation();
		}));
		this.update();
	}
	focus(): void { (this.list.firstElementChild as HTMLElement | null)?.focus(); }
	private update(): void {
		const models = waitingAgents(this.agents.snapshot);
		const active = dom.getActiveElement();
		const hadFocus = this.element.contains(active);
		for (const [key] of this.rows) { if (!models.some(model => model.key === key)) { this.rows.deleteAndDispose(key); } }
		for (const [index, model] of models.entries()) {
			let row = this.rows.get(model.key);
			if (!row) { row = new WaitingRow(model, this.agents, this.commands, this.close); this.rows.set(model.key, row); }
			row.update(model);
			if (this.list.children[index] !== row.element) { this.list.insertBefore(row.element, this.list.children[index] ?? null); }
		}
		this.heading.textContent = localize('waiting.count', "Waiting on You · {0}", models.length);
		if (!models.length) { this.close(); }
		else if (hadFocus && !this.element.contains(dom.getActiveElement())) { this.focus(); }
	}
}

registerAction2(class extends Action2 {
	private previous: string | undefined;
	constructor() {
		super({ id: 'outscaled.agents.nextWaiting', title: localize2('waiting.next', "Jump to Next Waiting Agent"), f1: true,
			keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyJ, weight: KeybindingWeight.WorkbenchContrib + 100 } });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const agents = accessor.get(IAgentsService);
		const next = nextWaitingAgent(agents.snapshot, this.previous);
		this.previous = next?.key;
		if (next) { await agents.request({ version: 1, action: 'focus', workspace: next.workspace.id, terminal: next.pane.id }); }
	}
});
