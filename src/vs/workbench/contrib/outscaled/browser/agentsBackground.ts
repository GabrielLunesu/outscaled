/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { getAnchorRect } from '../../../../base/browser/ui/contextview/contextview.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { AnchorPosition } from '../../../../base/common/layout.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { AgentsRequest, agentsRequestCommand, isAgentsReceipt } from '../common/agentsBridge.js';
import { isLaunchInterval } from '../common/agentsLaunch.js';
import { BackgroundAgent, backgroundAgents, runStatusLabel, scheduleTime } from './agentsBackgroundModel.js';
import { IAgentsService } from './agentsService.js';
import { agentStatusLabel } from './agentsSidebarModel.js';
import './media/agentsBackground.css';

class BackgroundChip extends Disposable {
	readonly element = dom.$<HTMLButtonElement>('button.outscaled-background-chip', { type: 'button', tabindex: '-1', 'aria-haspopup': 'dialog' });
	private readonly dot = dom.append(this.element, dom.$('span.outscaled-status-dot', { 'aria-hidden': 'true' }));
	private readonly name = dom.append(this.element, dom.$('span.outscaled-background-name'));
	private readonly runtime = dom.append(this.element, dom.$('span.outscaled-runtime-badge'));
	private readonly line = dom.append(this.element, dom.$('span.outscaled-background-line'));
	private readonly next = dom.append(this.element, dom.$('span.outscaled-background-next'));
	model: BackgroundAgent;
	constructor(model: BackgroundAgent, hover: IHoverService, open: (chip: BackgroundChip) => void) {
		super(); this.model = model;
		this._register(toDisposable(() => this.element.remove()));
		this._register(hover.setupManagedHover(getDefaultHoverDelegate('mouse'), this.element, () => this.model.label));
		this._register(dom.addDisposableListener(this.element, 'click', () => open(this)));
		this.update(model);
	}
	update(model: BackgroundAgent): void {
		this.model = model; this.element.dataset.agentId = model.id; this.element.dataset.terminalId = model.terminal;
		this.element.dataset.status = model.status; this.dot.textContent = model.status === 'crashed' ? '×' : '';
		this.element.setAttribute('aria-label', model.label); this.name.textContent = model.name; this.runtime.textContent = model.runtime;
		this.line.textContent = model.latestLine; this.next.textContent = model.schedule ? model.next : ''; this.next.hidden = !model.schedule;
	}
}

/** Kept alive while its chip updates; input, selection and keyboard focus survive snapshots. */
class AgentCard extends Disposable {
	readonly element = dom.$('.outscaled-agent-card', { role: 'dialog', tabindex: '-1' });
	private readonly title = dom.append(this.element, dom.$('h3'));
	private readonly status = dom.append(this.element, dom.$('p.outscaled-card-status'));
	private readonly latest = dom.append(this.element, dom.$('p.outscaled-card-latest'));
	private readonly details = dom.append(this.element, dom.$('dl'));
	private readonly prompt = this.field(localize('background.prompt', "Prompt"));
	private readonly every = this.field(localize('background.interval', "Interval"));
	private readonly last = this.field(localize('background.last', "Last Run"));
	private readonly result = this.field(localize('background.result', "Result"));
	private readonly next = this.field(localize('background.nextRun', "Next Run"));
	private readonly editNote = dom.append(this.element, dom.$('p'));
	private readonly actions = dom.append(this.element, dom.$('.outscaled-card-actions'));
	private readonly open: HTMLButtonElement;
	private readonly run: HTMLButtonElement;
	private readonly edit: HTMLButtonElement;
	private readonly pause: HTMLButtonElement;
	private readonly remove: HTMLButtonElement;
	private readonly reason = dom.append(this.element, dom.$('p.outscaled-card-reason'));
	private readonly error = dom.append(this.element, dom.$('p', { role: 'status' }));
	private readonly form = dom.append(this.element, dom.$('form.outscaled-schedule-edit'));
	private readonly promptInput: HTMLTextAreaElement;
	private readonly intervalInput: HTMLInputElement;
	private readonly save: HTMLButtonElement;
	private readonly controls: HTMLElement[] = [];
	private busy = false;
	private model: BackgroundAgent;
	constructor(model: BackgroundAgent, private readonly workspace: string, private readonly agents: IAgentsService,
		private readonly commands: ICommandService, private readonly dialogs: IDialogService, hover: IHoverService, private readonly close: () => void) {
		super(); this.model = model;
		this._register(toDisposable(() => this.element.remove()));
		this._register(hover.setupManagedHover(getDefaultHoverDelegate('mouse'), this.latest, () => this.model.latestLine));
		this.open = this.button(this.actions, localize('background.open', "Open in Grid"), async () => {
			const terminal = this.model.terminal;
			if (!terminal) { return; }
			this.close();
			await this.agents.request({ version: 1, action: 'openInGrid', workspace, terminal, focused: agents.owners.get(workspace)?.active });
		});
		this.run = this.button(this.actions, localize('background.runNow', "Run Now"), () => this.change('run'));
		this.edit = this.button(this.actions, localize('background.edit', "Edit"), async () => {
			this.promptInput.value = this.model.schedule?.prompt ?? ''; this.intervalInput.value = this.model.schedule!.every;
			this.form.hidden = false; this.validate(); this.promptInput.focus();
		});
		this.pause = this.button(this.actions, '', () => this.change(this.model.schedule!.paused ? 'resume' : 'pause'));
		this.remove = this.button(this.actions, localize('background.delete', "Delete"), async () => {
			const confirmation = await this.dialogs.confirm({ message: localize('background.confirmDelete', "Delete schedule {0}?", this.model.name),
				detail: localize('background.deleteDetail', "Future runs will stop. Existing terminals and run history are kept."), primaryButton: localize('background.delete', "Delete"), custom: true });
			if (confirmation.confirmed) { await this.change('delete'); }
		});
		this.promptInput = dom.append(dom.append(this.form, dom.$('label', undefined, localize('background.editPrompt', "Prompt (Required)"))), dom.$('textarea', { rows: '4', maxlength: '32768', required: 'true' }));
		this.intervalInput = dom.append(dom.append(this.form, dom.$('label', undefined, localize('background.editInterval', "Interval"))), dom.$('input', { type: 'text', required: 'true' }));
		this.controls.push(this.promptInput, this.intervalInput);
		this.save = this.button(this.form, localize('background.save', "Save"), () => this.send({ version: 1, action: 'editSchedule', workspace, name: this.model.name, prompt: this.promptInput.value, every: this.intervalInput.value }));
		this.button(this.form, localize('background.cancel', "Cancel"), async () => { this.form.hidden = true; this.edit.focus(); });
		this.form.hidden = true;
		this._register(dom.addDisposableListener(this.form, 'submit', event => event.preventDefault()));
		for (const input of [this.promptInput, this.intervalInput]) { this._register(dom.addDisposableListener(input, 'input', () => this.validate())); }
		this._register(dom.addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape') { this.close(); event.preventDefault(); }
			if (event.key === 'Tab') {
				const controls = this.controls.filter(control => control.offsetParent !== null && (!dom.isHTMLButtonElement(control) || !control.disabled));
				const first = controls[0]; const last = controls.at(-1);
				if (event.shiftKey && (event.target === first || event.target === this.element)) { last?.focus(); event.preventDefault(); }
				else if (!event.shiftKey && event.target === last) { first?.focus(); event.preventDefault(); }
			}
			event.stopPropagation();
		}));
		this.update(model);
	}
	private field(label: string): HTMLElement { dom.append(this.details, dom.$('dt', undefined, label)); return dom.append(this.details, dom.$('dd')); }
	private button(parent: HTMLElement, label: string, run: () => Promise<void>): HTMLButtonElement {
		const button = dom.append(parent, dom.$<HTMLButtonElement>('button', { type: 'button' }, label));
		this.controls.push(button);
		this._register(dom.addDisposableListener(button, 'click', () => { if (!button.disabled && !this.busy) { void run(); } })); return button;
	}
	private validate(): void { this.save.disabled = this.busy || this.model.offline || !this.promptInput.value.trim() || !isLaunchInterval(this.intervalInput.value); }
	private change(operation: 'run' | 'pause' | 'resume' | 'delete'): Promise<void> { return this.send({ version: 1, action: 'schedule', workspace: this.workspace, name: this.model.name, operation }); }
	private async send(request: AgentsRequest): Promise<void> {
		if (this.busy) { return; } this.busy = true; this.error.textContent = ''; this.update(this.model);
		try {
			const receipt = await this.commands.executeCommand<unknown>(agentsRequestCommand, request);
			if (!isAgentsReceipt(receipt) || !receipt.ok) { throw new Error(isAgentsReceipt(receipt) ? receipt.error : localize('background.failedRequest', "The agents request failed.")); }
			if (request.action === 'editSchedule') { this.form.hidden = true; this.edit.focus(); }
		} catch (error) { this.error.textContent = String(error); }
		finally { this.busy = false; this.update(this.model); }
	}
	update(model: BackgroundAgent): void {
		this.model = model; this.element.setAttribute('aria-label', model.name); this.element.dataset.status = model.status;
		this.title.textContent = model.name; this.status.textContent = localize('background.cardStatus', "{0} · {1}", model.runtime, agentStatusLabel(model.status));
		this.latest.textContent = model.latestLine || localize('background.noOutput', "No output yet.");
		const schedule = model.schedule; this.details.hidden = !schedule;
		this.open.disabled = this.busy || !!model.openReason;
		for (const button of [this.run, this.edit, this.pause, this.remove]) { button.hidden = !schedule; button.disabled = this.busy; }
		this.run.disabled ||= !!model.runReason; this.edit.hidden = this.remove.hidden = !model.editable;
		this.pause.disabled ||= model.offline; this.edit.disabled ||= model.offline; this.remove.disabled ||= model.offline;
		this.editNote.textContent = model.editReason; this.editNote.hidden = !model.editReason;
		this.reason.textContent = [model.openReason, schedule && model.runReason].filter(Boolean).join(' ');
		if (schedule) {
			this.prompt.textContent = schedule.prompt ?? schedule.command ?? ''; this.every.textContent = schedule.every;
			this.last.textContent = schedule.lastRun ? localize('background.lastValue', "{0} · {1}", scheduleTime(schedule.lastRun.startedAt), runStatusLabel(schedule.lastRun.status)) : localize('background.never', "Never Run");
			this.result.textContent = schedule.lastRun?.result.split(/\r?\n/)[0] ?? '';
			this.next.textContent = schedule.paused ? localize('background.paused', "Paused") : scheduleTime(schedule.nextRunAt); this.pause.textContent = schedule.paused ? localize('background.resume', "Resume") : localize('background.pause', "Pause");
		}
		this.validate();
	}
}

/** Keyed chips preserve focus, hover and scroll position during live stream updates. */
export class AgentsBackground extends Disposable {
	readonly element = dom.$('section.outscaled-background', { 'aria-label': localize('background.title', "Background Agents") });
	private readonly heading = dom.append(this.element, dom.$('span.outscaled-background-heading'));
	private readonly list = dom.append(this.element, dom.$('.outscaled-background-list', { role: 'toolbar', 'aria-label': localize('background.title', "Background Agents") }));
	private readonly empty = dom.append(this.element, dom.$('span.outscaled-background-empty', undefined, localize('background.empty', "No agents in the background")));
	private readonly chips = this._register(new DisposableMap<string, BackgroundChip>());
	private readonly card = this._register(new MutableDisposable<AgentCard>());
	private closeCard: (() => void) | undefined;
	private focused: string | undefined;
	private workspace: string | undefined;
	private order: string[] = [];
	constructor(@IAgentsService private readonly agents: IAgentsService, @IHoverService private readonly hover: IHoverService,
		@IContextViewService private readonly context: IContextViewService, @ICommandService private readonly commands: ICommandService,
		@IDialogService private readonly dialogs: IDialogService) {
		super();
		this._register(toDisposable(() => this.closeCard?.()));
		this._register(agents.onDidChange(() => this.update()));
		this._register(dom.addDisposableListener(this.list, 'keydown', event => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
			const chips = this.order.map(id => this.chips.get(id)!); const index = chips.findIndex(chip => chip.element === event.target);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? chips.length - 1 : (index + (event.key === 'ArrowLeft' ? chips.length - 1 : 1)) % chips.length;
			const chip = chips[next]; if (chip) { this.focused = chip.model.id; this.tabStops(); chip.element.focus(); chip.element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
			event.preventDefault(); event.stopPropagation();
		}));
		this.update();
	}
	close(): void { this.closeCard?.(); }
	private tabStops(): void { for (const [id, chip] of this.chips) { chip.element.tabIndex = id === this.focused ? 0 : -1; } this.list.tabIndex = this.chips.size ? -1 : 0; }
	private update(): void {
		const workspace = this.agents.snapshot.workspaces.find(workspace => workspace.selected);
		if (this.workspace !== workspace?.id) { this.close(); this.chips.clearAndDisposeAll(); this.workspace = workspace?.id; }
		const models = workspace ? backgroundAgents(workspace) : [];
		this.order = models.map(model => model.id);
		const hadFocus = this.list.contains(dom.getActiveElement());
		for (const [id] of this.chips) { if (!models.some(model => model.id === id)) { if (this.focused === id) { this.close(); } this.chips.deleteAndDispose(id); } }
		for (const [index, model] of models.entries()) {
			let chip = this.chips.get(model.id);
			if (!chip) { chip = new BackgroundChip(model, this.hover, chip => this.showCard(chip)); this.chips.set(model.id, chip); }
			chip.update(model);
			if (this.list.children[index] !== chip.element) { this.list.insertBefore(chip.element, this.list.children[index] ?? null); }
		}
		if (!this.focused || !this.chips.has(this.focused)) { this.focused = models[0]?.id; this.tabStops(); if (hadFocus) { (this.focused ? this.chips.get(this.focused)!.element : this.list).focus(); } }
		const model = models.find(model => model.id === this.focused); if (model) { this.card.value?.update(model); }
		this.tabStops(); this.empty.hidden = !!models.length; this.element.classList.toggle('empty', !models.length);
		this.heading.textContent = localize('background.count', "Background · {0}", models.length);
	}
	private showCard(chip: BackgroundChip): void {
		this.close(); this.focused = chip.model.id; this.tabStops();
		chip.element.setAttribute('aria-expanded', 'true');
		const view = this.context.showContextView({ getAnchor: () => {
			// A horizontally scrolled chip can be partially clipped; anchor to its visible part.
			const anchor = getAnchorRect(chip.element); const visible = getAnchorRect(this.list);
			const left = Math.max(anchor.left, visible.left);
			const right = Math.min(anchor.left + anchor.width, visible.left + visible.width);
			return { x: left, y: anchor.top, width: Math.max(1, right - left), height: anchor.height };
		}, anchorPosition: AnchorPosition.ABOVE,
			render: container => {
				const store = new DisposableStore();
				this.card.value = new AgentCard(chip.model, this.workspace!, this.agents, this.commands, this.dialogs, this.hover, () => this.close());
				container.append(this.card.value.element);
				store.add(dom.addDisposableListener(this.list, 'scroll', () => {
					const anchor = getAnchorRect(chip.element); const visible = getAnchorRect(this.list);
					if (anchor.left + anchor.width <= visible.left || anchor.left >= visible.left + visible.width) { this.close(); }
					else { this.context.layout(); }
				}));
				const observer = new (dom.getWindow(container).ResizeObserver)(() => this.context.layout());
				store.add(toDisposable(() => observer.disconnect())); observer.observe(this.card.value.element);
				store.add(dom.addDisposableListener(dom.getWindow(container).document, 'mousedown', event => {
					if (dom.isHTMLElement(event.target) && !this.card.value?.element.contains(event.target) && !chip.element.contains(event.target)) { this.close(); }
				}, true));
				store.add(toDisposable(() => this.card.clear())); return store;
			}, focus: () => this.card.value?.element.focus(), onHide: () => {
				this.closeCard = undefined; chip.element.setAttribute('aria-expanded', 'false'); this.card.clear(); if (chip.element.isConnected) { chip.element.focus(); }
			} });
		this.closeCard = () => view.close();
	}
}
