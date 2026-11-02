/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
// eslint-disable-next-line local/code-translation-remind
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { AgentsPreset, AgentsLaunch, defaultLaunch, layoutCounts, parseAgentsCommand } from '../common/agentsLaunch.js';
import { AgentsRequest, AgentsWorkspace, agentsRequestCommand, isAgentsReceipt } from '../common/agentsBridge.js';
import { AgentsLayout, LayoutId, layoutIds, layoutTerminals, presetLayout } from '../common/agentsLayout.js';
import { IAgentsService } from './agentsService.js';
import './media/agentsDialog.css';

const layoutLabels: Record<LayoutId, string> = {
	single: localize('launch.single', "Single"), 'side-by-side': localize('launch.side', "Side by Side"),
	stacked: localize('launch.stacked', "Stacked"), '2x2': localize('launch.grid', "2×2"),
	'four-across': localize('launch.across', "Four Across"), '2+1': localize('launch.twoOne', "Two Stacked + Right")
};
const agentLabels = { claude: localize('launch.claude', "Claude"), codex: localize('launch.codex', "Codex"), shell: localize('launch.shell', "Shell") };

/** A native modal provides focus containment and makes the underlying terminals inert. */
class AgentsDialog extends Disposable {
	private readonly element = dom.$<HTMLDialogElement>('dialog.outscaled-new-agents');
	private readonly choicesStore = this._register(new DisposableStore());
	private readonly presetStore = this._register(new DisposableStore());
	private choices = defaultLaunch();
	private readonly query: HTMLInputElement;
	private readonly interpretation: HTMLElement;
	private readonly panes: HTMLElement;
	private readonly runs: HTMLSelectElement;
	private readonly interval: HTMLInputElement;
	private readonly where: HTMLSelectElement;
	private readonly prompt: HTMLTextAreaElement;
	private readonly note: HTMLElement;
	private readonly create: HTMLButtonElement;
	private readonly presetName: HTMLInputElement;
	private readonly presetButtons: HTMLElement;
	private readonly presetChoices = new Map<HTMLButtonElement, AgentsLaunch>();
	private readonly layoutButtons = new Map<LayoutId, HTMLButtonElement>();
	private busy = false;
	private closed = false;
	private launched = false;
	private focused: string | undefined;

	constructor(private readonly workspace: AgentsWorkspace, private readonly restoreFocus: () => void,
		@IAgentsService private readonly agents: IAgentsService, @ICommandService private readonly commands: ICommandService,
		@ILayoutService layout: ILayoutService) {
		super();
		this.focused = agents.owners.get(workspace.id)?.active;
		if (!this.focused || !layoutTerminals(workspace.layout).includes(this.focused)) { this.focused = layoutTerminals(workspace.layout)[0]; }
		this.element.setAttribute('aria-label', localize('launch.title', "New Agents"));
		const content = dom.append(this.element, dom.$('.outscaled-launch-content'));
		dom.append(content, dom.$('h2', undefined, localize('launch.heading', "New agents in {0}", workspace.name)));
		this.query = this.input(content, localize('launch.type', "Type What You Want"));
		this.query.placeholder = localize('launch.placeholder', "2x2 claude, codex right, claude every 30m…");
		this.query.classList.add('outscaled-launch-query');
		this.interpretation = dom.append(content, dom.$('p.outscaled-launch-interpretation', { 'aria-live': 'polite' }));
		this.presetButtons = this.group(content, localize('launch.presets', "Presets"));
		const columns = dom.append(content, dom.$('.outscaled-launch-columns'));
		const left = dom.append(columns, dom.$('div'));
		const layouts = this.group(left, localize('launch.layout', "Layout"));
		for (const id of layoutIds) {
			const button = this.button(layouts, '', () => { this.choices.layout = id; this.choices.agents = Array.from({ length: layoutCounts[id] }, (_, index) => this.choices.agents[index] ?? this.choices.agents[0]); this.refresh(); });
			button.setAttribute('aria-label', layoutLabels[id]);
			button.classList.add('outscaled-layout-choice');
			button.append(this.shape(presetLayout(id, Array.from({ length: layoutCounts[id] }, (_, index) => String(index))), () => dom.$('span.outscaled-layout-cell')));
			this.layoutButtons.set(id, button);
		}
		this.panes = this.group(left, localize('launch.panes', "Agent per Pane"));
		const right = dom.append(columns, dom.$('div'));
		this.runs = this.select(right, localize('launch.runs', "Runs"), [
			['quick', localize('launch.quick', "Quick")], ['always', localize('launch.always', "Always On")], ['scheduled', localize('launch.scheduled', "Scheduled")]
		]);
		this.interval = this.input(right, localize('launch.interval', "Interval"));
		this.interval.placeholder = localize('launch.intervalExample', "30m, 2h or 1d");
		const focusedName = workspace.terminals.find(pane => pane.id === this.focused)?.name;
		this.where = this.select(right, localize('launch.where', "Where"), [
			['replace', localize('launch.replace', "Replace View")], ['add', localize('launch.add', "Add to View")],
			['right', focusedName ? localize('launch.right', "Right of {0}", focusedName) : localize('launch.noFocus', "Right of the Focused Pane")],
			['below', focusedName ? localize('launch.below', "Below {0}", focusedName) : localize('launch.belowFocus', "Below the Focused Pane")]
		]);
		for (const option of Array.from(this.where.options)) { if (option.value === 'right' || option.value === 'below') { option.disabled = !this.focused; } }
		dom.append(right, dom.$('p.outscaled-launch-help', undefined, localize('launch.keepRunning', "Replacing the view keeps its agents running. Always On restarts a terminal if it dies.")));
		const promptLabel = dom.append(content, dom.$('label', undefined, localize('launch.prompt', "First Prompt (Optional)")));
		this.prompt = dom.append(promptLabel, dom.$('textarea', { rows: '2', maxlength: '32768' }));
		this.note = dom.append(this.element, dom.$('p.outscaled-launch-note', { role: 'status' }));
		const footer = dom.append(this.element, dom.$('footer'));
		this.presetName = this.input(footer, localize('launch.presetName', "Preset Name"));
		this.presetName.maxLength = 128;
		this.button(footer, localize('launch.save', "Save as Preset"), () => { void this.savePreset(); });
		this.button(footer, localize('launch.cancel', "Cancel"), () => this.dispose());
		this.create = this.button(footer, localize('launch.create', "Create"), () => { void this.launch(); });
		this.create.classList.add('primary');
		this._register(dom.addDisposableListener(this.query, 'input', () => {
			const parsed = parseAgentsCommand(this.query.value);
			this.choices = { ...parsed.choices, prompt: this.prompt.value };
			this.refresh();
			this.interpretation.textContent = !this.query.value.trim() ? localize('launch.hint', "Type a command or choose a preset below.") :
				!parsed.understood ? localize('launch.notUnderstood', "Not understood. Ignored: {0}", parsed.ignored.join(' ')) :
				localize('launch.read', "{0} · {1} · {2} · {3}{4}", layoutLabels[this.choices.layout], this.choices.agents.map(agent => agentLabels[agent]).join(', '), this.runs.selectedOptions[0].text, this.where.selectedOptions[0].text,
					parsed.ignored.length ? localize('launch.ignored', " · Ignored: {0}", parsed.ignored.join(' ')) : '');
		}));
		this._register(dom.addDisposableListener(this.runs, 'change', () => { this.choices.run = this.runs.value as AgentsLaunch['run']; this.refresh(); }));
		this._register(dom.addDisposableListener(this.where, 'change', () => { this.choices.where = this.where.value as AgentsLaunch['where']; this.refresh(); }));
		this._register(dom.addDisposableListener(this.interval, 'input', () => { this.choices.interval = this.interval.value; this.updatePresetSelection(); }));
		this._register(dom.addDisposableListener(this.prompt, 'input', () => { this.choices.prompt = this.prompt.value; this.updatePresetSelection(); }));
		this._register(dom.addDisposableListener(this.element, 'cancel', event => { event.preventDefault(); this.dispose(); }));
		this._register(dom.addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Enter' && !event.shiftKey && (event.target === this.query || event.target === this.prompt)) { event.preventDefault(); void this.launch(); }
			event.stopPropagation();
		}));
		dom.append(layout.activeContainer, this.element);
		this.refresh();
		this.interpretation.textContent = localize('launch.hint', "Type a command or choose a preset below.");
		this.element.showModal(); this.query.focus();
		void this.loadPresets();
	}
	private input(parent: HTMLElement, label: string): HTMLInputElement {
		return dom.append(dom.append(parent, dom.$('label', undefined, label)), dom.$('input', { type: 'text' }));
	}
	private select(parent: HTMLElement, label: string, options: string[][]): HTMLSelectElement {
		const select = dom.append(dom.append(parent, dom.$('label', undefined, label)), dom.$<HTMLSelectElement>('select', { 'aria-label': label }));
		for (const [value, text] of options) { dom.append(select, dom.$('option', { value }, text)); }
		return select;
	}
	private group(parent: HTMLElement, label: string): HTMLElement {
		const fieldset = dom.append(parent, dom.$('fieldset'));
		dom.append(fieldset, dom.$('legend', undefined, label));
		const options = dom.append(fieldset, dom.$('.outscaled-launch-options'));
		this._register(dom.addDisposableListener(options, 'keydown', event => {
			if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !dom.isHTMLButtonElement(event.target)) { return; }
			const buttons = Array.from(options.children).filter(dom.isHTMLButtonElement);
			const index = buttons.indexOf(event.target);
			const next = buttons[(index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? buttons.length - 1 : 1)) % buttons.length];
			next?.focus(); next?.click(); event.preventDefault();
		}));
		return options;
	}
	private button(parent: HTMLElement, label: string, run: () => void, store?: DisposableStore): HTMLButtonElement {
		const button = dom.append(parent, dom.$<HTMLButtonElement>('button', { type: 'button' }, label));
		const listener = dom.addDisposableListener(button, 'click', run);
		if (store) { store.add(listener); } else { this._register(listener); }
		return button;
	}
	private shape(tree: AgentsLayout, pane: (index: number) => HTMLElement): HTMLElement {
		if (tree.type === 'pane') { return pane(Number(tree.terminal)); }
		const split = dom.$('.outscaled-launch-shape'); split.dataset.direction = tree.direction;
		split.append(...tree.children.map(child => this.shape(child, pane))); return split;
	}
	private updatePresetSelection(): void {
		const key = (choices: AgentsLaunch) => JSON.stringify([choices.layout, choices.agents, choices.run, choices.interval, choices.where, choices.prompt]);
		for (const [button, choices] of this.presetChoices) { button.setAttribute('aria-pressed', String(key(choices) === key(this.choices))); }
	}
	private refresh(): void {
		this.updatePresetSelection();
		for (const [id, button] of this.layoutButtons) { button.setAttribute('aria-pressed', String(id === this.choices.layout)); }
		this.choicesStore.clear();
		this.panes.replaceChildren(this.shape(presetLayout(this.choices.layout, this.choices.agents.map((_, index) => String(index))), index => {
			const pane = dom.$('div.outscaled-launch-pane');
			const select = this.select(pane, localize('launch.pane', "Pane {0}", index + 1), Object.entries(agentLabels));
			select.value = this.choices.agents[index];
			this.choicesStore.add(dom.addDisposableListener(select, 'change', () => { this.choices.agents[index] = select.value as AgentsLaunch['agents'][number]; this.updatePresetSelection(); }));
			return pane;
		}));
		this.runs.value = this.choices.run; this.interval.value = this.choices.interval;
		this.interval.parentElement!.hidden = this.choices.run !== 'scheduled';
		this.where.value = this.choices.where; this.prompt.value = this.choices.prompt;
		this.note.textContent = this.choices.run === 'scheduled' ? localize('launch.notYet', "Scheduled agents in terminals are coming in Phase 4, item 5. Choose Quick or Always On to create agents now.") : '';
		this.create.disabled = this.busy || this.choices.run === 'scheduled' || ((this.choices.where === 'right' || this.choices.where === 'below') && !this.focused);
	}
	private async send(request: AgentsRequest) {
		const receipt = await this.commands.executeCommand<unknown>(agentsRequestCommand, request);
		if (!isAgentsReceipt(receipt) || !receipt.ok) { throw new Error(isAgentsReceipt(receipt) && receipt.error ? receipt.error : localize('launch.failed', "The agents request failed.")); }
		return receipt;
	}
	private showPresets(presets: AgentsPreset[]): void {
		if (this.closed) { return; }
		this.presetStore.clear(); this.presetChoices.clear(); this.presetButtons.replaceChildren();
		for (const preset of presets) {
			const button = this.button(this.presetButtons, preset.name, () => { this.choices = structuredClone(preset.choices); this.query.value = ''; this.refresh(); this.interpretation.textContent = localize('launch.chosen', "Preset: {0}", preset.name); }, this.presetStore);
			this.presetChoices.set(button, preset.choices);
		}
		this.updatePresetSelection();
	}
	private async loadPresets(): Promise<void> {
		try { this.showPresets((await this.send({ version: 1, action: 'presets', workspace: this.workspace.id })).presets ?? []); }
		catch (error) { if (!this.closed) { this.note.textContent = String(error); } }
	}
	private async savePreset(): Promise<void> {
		if (this.busy) { return; }
		if (!this.presetName.value.trim()) { this.presetName.focus(); this.note.textContent = localize('launch.needName', "Enter a preset name first."); return; }
		this.busy = true;
		try { this.showPresets((await this.send({ version: 1, action: 'savePreset', workspace: this.workspace.id, name: this.presetName.value.trim(), choices: this.choices })).presets ?? []); this.note.textContent = localize('launch.saved', "Preset saved for this workspace."); }
		catch (error) { this.note.textContent = String(error); }
		finally { this.busy = false; }
	}
	private async launch(): Promise<void> {
		if (this.create.disabled || this.busy) { return; }
		this.busy = true; this.create.disabled = true;
		try {
			await this.send({ version: 1, action: 'launch', workspace: this.workspace.id, choices: structuredClone(this.choices), focused: this.focused });
			this.launched = true; this.dispose();
			this.agents.owners.get(this.workspace.id)?.focus(this.agents.snapshot.focus?.terminal);
		} catch (error) { if (!this.closed) { this.note.textContent = String(error); } }
		finally { this.busy = false; if (!this.closed) { this.create.disabled = this.choices.run === 'scheduled'; } }
	}
	override dispose(): void {
		if (this.closed) { return; } this.closed = true;
		this.element.close(); this.element.remove(); super.dispose();
		if (!this.launched) { this.restoreFocus(); }
	}
}

const IAgentsLauncher = createDecorator<IAgentsLauncher>('outscaledAgentsLauncher');
interface IAgentsLauncher { readonly _serviceBrand: undefined; open(): Promise<void> }
class AgentsLauncher extends Disposable implements IAgentsLauncher {
	declare readonly _serviceBrand: undefined;
	private readonly dialog = this._register(new MutableDisposable<AgentsDialog>());
	constructor(@IAgentsService private readonly agents: IAgentsService, @IInstantiationService private readonly instantiation: IInstantiationService,
		@ICommandService private readonly commands: ICommandService) { super(); }
	async open(): Promise<void> {
		const workspace = this.agents.snapshot.workspaces.find(workspace => workspace.selected);
		if (!workspace) { await this.commands.executeCommand('outscaled.switchWorkspace'); return; }
		this.dialog.clear();
		const previousMode = this.agents.mode;
		const previousFocus = dom.getActiveElement();
		await this.commands.executeCommand('outscaled.agents.mode', 'agents');
		this.dialog.value = this.instantiation.createInstance(AgentsDialog, workspace, () => {
			const focus = () => { if (dom.isHTMLElement(previousFocus) && previousFocus.isConnected) { previousFocus.focus(); } };
			if (previousMode === 'code') { void this.commands.executeCommand('outscaled.agents.mode', 'code').then(focus); }
			else { focus(); }
		});
	}
}
registerSingleton(IAgentsLauncher, AgentsLauncher, InstantiationType.Delayed);
registerAction2(class extends Action2 {
	constructor() { super({ id: 'outscaled.agents.new', title: localize2('launch.action', "New Agents"), f1: true,
		keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyN, weight: KeybindingWeight.WorkbenchContrib + 100 } }); }
	async run(accessor: import('../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> { await accessor.get(IAgentsLauncher).open(); }
});
