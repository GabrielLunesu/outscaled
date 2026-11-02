/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { emptyProgressRunner, IEditorProgressService } from '../../../../platform/progress/common/progress.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { AgentChangedFile, AgentsRequest, AgentsWorkspace, agentsRequestCommand, isAgentsReceipt } from '../common/agentsBridge.js';
import { changesModel, changeStatusLabel, commitDisabledReason, inferredChangeExplanation } from './agentsChangesModel.js';
import { IAgentsService } from './agentsService.js';
import './media/agentsChanges.css';

class ChangeRow extends Disposable {
	readonly element = dom.$('button.outscaled-change-row', { type: 'button', role: 'option', tabindex: '-1' });
	private readonly status = dom.append(this.element, dom.$('span.outscaled-change-status'));
	private readonly details = dom.append(this.element, dom.$('span.outscaled-change-details'));
	private readonly path = dom.append(this.details, dom.$('span.outscaled-change-path'));
	private readonly attribution = dom.append(this.details, dom.$('span.outscaled-change-attribution'));
	private readonly noAttribution = dom.append(this.attribution, dom.$('span', undefined, localize('changes.noAttribution', "No observed agent edit")));
	private readonly hovers = this._register(new DisposableMap<string>());
	private readonly labels = new Map<string, HTMLElement>();
	private signature = '';
	constructor(readonly filePath: string, private readonly hover: IHoverService, select: () => void) {
		super(); this.element.dataset.path = filePath;
		this._register(toDisposable(() => this.element.remove()));
		this._register(dom.addDisposableListener(this.element, 'click', select));
	}
	update(file: AgentChangedFile): void {
		const signature = JSON.stringify(file);
		if (signature === this.signature) { return; } this.signature = signature;
		this.status.textContent = changeStatusLabel(file.status); this.status.dataset.status = file.status;
		this.path.textContent = file.originalPath ? localize('changes.renamePath', "{0} → {1}", file.originalPath, file.path) : file.path;
		const key = (agent: AgentChangedFile['agents'][number]) => JSON.stringify([agent.terminal, agent.runtime]);
		for (const [id, label] of this.labels) {
			if (!file.agents.some(agent => key(agent) === id)) { label.remove(); this.labels.delete(id); this.hovers.deleteAndDispose(id); }
		}
		for (const [index, agent] of file.agents.entries()) {
			const id = key(agent);
			let label = this.labels.get(id);
			if (!label) {
				label = dom.$('span'); this.labels.set(id, label);
				const target = label;
				this.hovers.set(id, this.hover.setupManagedHover(getDefaultHoverDelegate('mouse'), label, () => target.classList.contains('approximate') ? inferredChangeExplanation : target.textContent ?? ''));
			}
			label.textContent = agent.inferred ? localize('changes.approximate', "{0} (approximate)", agent.terminal) : agent.terminal;
			label.classList.toggle('approximate', agent.inferred);
			if (this.attribution.children[index + 1] !== label) { this.attribution.insertBefore(label, this.attribution.children[index + 1] ?? null); }
		}
		this.noAttribution.hidden = !!file.agents.length;
	}
}

/** Native diff widget and model references belong only to this drawer's lifetime. */
export class AgentsChangesDrawer extends Disposable {
	readonly element = dom.$('section.outscaled-changes-drawer', { role: 'dialog', 'aria-label': localize('changes.title', "Changes"), tabindex: '-1' });
	private readonly heading = dom.append(this.element, dom.$('header'));
	private readonly title = dom.append(this.heading, dom.$('h2'));
	private readonly note = dom.append(this.element, dom.$('p.outscaled-changes-note'));
	private readonly dataError = dom.append(this.element, dom.$('p.outscaled-changes-error', { role: 'status' }));
	private readonly unavailable = dom.append(this.element, dom.$('p.outscaled-changes-note'));
	private readonly content = dom.append(this.element, dom.$('.outscaled-changes-content'));
	private readonly list = dom.append(this.content, dom.$('.outscaled-changes-list', { role: 'listbox', 'aria-label': localize('changes.files', "Changed Files") }));
	private readonly preview = dom.append(this.content, dom.$('.outscaled-changes-preview'));
	private readonly previewTitle = dom.append(this.preview, dom.$('h3'));
	private readonly previewNote = dom.append(this.preview, dom.$('p', { role: 'status' }));
	private readonly diffHost = dom.append(this.preview, dom.$('.outscaled-changes-diff'));
	private readonly footer = dom.append(this.element, dom.$('footer'));
	private readonly message = dom.append(this.footer, dom.$<HTMLTextAreaElement>('textarea', { rows: '2', maxlength: '32768', 'aria-label': localize('changes.commitMessage', "Commit Message"), placeholder: localize('changes.commitMessage', "Commit Message") }));
	private readonly actions = dom.append(this.footer, dom.$('.outscaled-changes-actions'));
	private readonly reason = dom.append(this.footer, dom.$('p.outscaled-commit-reason'));
	private readonly error = dom.append(this.footer, dom.$('p.outscaled-changes-error', { role: 'alert' }));
	private readonly open: HTMLButtonElement;
	private readonly commit: HTMLButtonElement;
	private readonly diff: DiffEditorWidget;
	private readonly models = this._register(new MutableDisposable<DisposableStore>());
	private readonly rows = this._register(new DisposableMap<string, ChangeRow>());
	private workspace: AgentsWorkspace | undefined;
	private files: AgentChangedFile[] = [];
	private selected: string | undefined;
	private focused: string | undefined;
	private previewSignature = '';
	private generation = 0;
	private busy = false;
	constructor(private readonly workspaceId: string, private readonly close: (restore?: boolean) => void,
		@IAgentsService private readonly agents: IAgentsService, @ICommandService private readonly commands: ICommandService,
		@IHoverService private readonly hover: IHoverService, @IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService context: IContextKeyService,
		@ITextModelService private readonly textModels: ITextModelService, @IWorkbenchLayoutService layout: IWorkbenchLayoutService) {
		super();
		this._register(toDisposable(() => { this.element.remove(); }));
		this.button(this.heading, localize('changes.close', "Close"), () => close());
		this.open = this.button(this.actions, localize('changes.open', "Open in Editor"), () => { void this.openEditor(); });
		this.commit = this.button(this.actions, localize('changes.commit', "Commit"), () => { void this.commitAll(); });
		const scoped = this._register(context.createScoped(this.element));
		const editorInstantiation = this._register(instantiation.createChild(new ServiceCollection(
			[IContextKeyService, scoped], [IEditorProgressService, { _serviceBrand: undefined, show: () => emptyProgressRunner, showWhile: async (promise: Promise<unknown>) => { await promise; } }]
		)));
		this.diff = this._register(editorInstantiation.createInstance(DiffEditorWidget, this.diffHost, { readOnly: true, originalEditable: false, automaticLayout: true,
			renderSideBySide: false, renderOverviewRuler: false, minimap: { enabled: false }, scrollBeyondLastLine: false }, {}));
		const position = () => { this.element.style.top = `${layout.getContainer(mainWindow, Parts.TITLEBAR_PART)?.offsetHeight ?? 0}px`; };
		this._register(layout.onDidLayoutMainContainer(position)); position();
		this._register(dom.addDisposableListener(this.message, 'input', () => this.validate()));
		this._register(dom.addDisposableListener(dom.getWindow(this.element).document, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
		}, true));
		this._register(dom.addDisposableListener(this.list, 'keydown', event => {
			const index = this.files.findIndex(file => file.path === this.focused);
			let next: number;
			if (event.key === 'ArrowDown') { next = Math.min(index + 1, this.files.length - 1); }
			else if (event.key === 'ArrowUp') { next = Math.max(0, index - 1); }
			else if (event.key === 'Home') { next = 0; }
			else if (event.key === 'End') { next = this.files.length - 1; }
			else if (event.key === 'Enter') { if (this.focused) { this.select(this.focused); } event.preventDefault(); event.stopPropagation(); return; }
			else { return; }
			this.focused = this.files[next]?.path; this.tabStops();
			if (this.focused) { const row = this.rows.get(this.focused)!; row.element.focus(); row.element.scrollIntoView({ block: 'nearest' }); }
			event.preventDefault(); event.stopPropagation();
		}));
		this._register(agents.onDidChange(() => this.update()));
		layout.mainContainer.append(this.element); this.update();
	}
	override dispose(): void { this.generation++; this.diff.setModel(null); super.dispose(); }
	private button(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const button = dom.append(parent, dom.$<HTMLButtonElement>('button', { type: 'button' }, label));
		this._register(dom.addDisposableListener(button, 'click', run)); return button;
	}
	focus(): void { (this.focused ? this.rows.get(this.focused)?.element : this.element)?.focus(); }
	private tabStops(): void { for (const [path, row] of this.rows) { row.element.tabIndex = path === this.focused ? 0 : -1; row.element.setAttribute('aria-selected', String(path === this.selected)); } }
	private update(): void {
		const workspace = this.agents.snapshot.workspaces.find(workspace => workspace.selected);
		if (workspace?.id !== this.workspaceId) { this.close(); return; }
		this.workspace = workspace;
		const model = changesModel(workspace); this.files = model.files;
		this.title.textContent = localize('changes.count', "Changes · {0}", this.files.length);
		this.note.textContent = model.note; this.note.hidden = !model.note;
		this.unavailable.textContent = model.unavailableLabel; this.unavailable.hidden = !model.unavailable;
		this.dataError.textContent = model.error; this.dataError.hidden = !model.error;
		const hadFocus = this.list.contains(dom.getActiveElement());
		for (const [path] of this.rows) { if (!this.files.some(file => file.path === path)) { this.rows.deleteAndDispose(path); } }
		for (const [index, file] of this.files.entries()) {
			let row = this.rows.get(file.path);
			if (!row) { row = new ChangeRow(file.path, this.hover, () => { this.focused = file.path; this.select(file.path); }); this.rows.set(file.path, row); }
			row.update(file);
			if (this.list.children[index] !== row.element) { this.list.insertBefore(row.element, this.list.children[index] ?? null); }
		}
		if (!this.focused || !this.rows.has(this.focused)) { this.focused = this.files[0]?.path; if (hadFocus) { this.focus(); } }
		if (this.selected && !this.rows.has(this.selected)) { this.selected = undefined; this.clearPreview(); }
		this.list.classList.toggle('empty', !this.files.length);
		this.list.setAttribute('aria-label', this.files.length ? localize('changes.files', "Changed Files") : localize('changes.clean', "No Changed Files"));
		if (this.files.length) { for (const node of [...this.list.childNodes]) { if (node.nodeType === node.TEXT_NODE) { node.remove(); } } }
		if (!this.files.length) { this.list.textContent = localize('changes.clean', "No Changed Files"); }
		else if (!this.selected) { this.select(this.files[0].path); }
		else if (JSON.stringify(this.files.find(file => file.path === this.selected)) !== this.previewSignature) { this.select(this.selected); }
		if (!this.selected) { this.previewNote.textContent = localize('changes.cleanDescription', "Your workspace has no changed files."); }
		this.tabStops(); this.validate();
	}
	private clearPreview(): void { this.generation++; this.diff.setModel(null); this.models.clear(); this.previewTitle.textContent = ''; this.previewSignature = ''; }
	private select(path: string): void {
		this.clearPreview(); this.selected = path; this.previewSignature = JSON.stringify(this.files.find(file => file.path === path));
		this.previewTitle.textContent = path; this.tabStops(); this.validate();
		if (this.workspace?.root.startsWith('ws:')) { this.previewNote.textContent = localize('changes.vpsPreview', "Open this file in Code mode to review it."); return; }
		this.previewNote.textContent = localize('changes.loading', "Loading Diff…");
		void this.loadDiff(path, this.generation);
	}
	private async send(request: AgentsRequest) {
		const receipt = await this.commands.executeCommand<unknown>(agentsRequestCommand, request);
		if (!isAgentsReceipt(receipt) || !receipt.ok) { throw new Error(isAgentsReceipt(receipt) ? receipt.error : localize('changes.failed', "The changes request failed.")); }
		return receipt;
	}
	private async loadDiff(path: string, generation: number): Promise<void> {
		try {
			const receipt = await this.send({ version: 1, action: 'changeDiff', workspace: this.workspaceId, path });
			if (generation !== this.generation) { return; }
			if (!receipt.changeEditor?.original) { throw new Error(localize('changes.noDiff', "No diff is available for this file.")); }
			const models = new DisposableStore(); this.models.value = models;
			const original = models.add(await this.textModels.createModelReference(URI.parse(receipt.changeEditor.original)));
			if (generation !== this.generation) { return; }
			const modified = models.add(await this.textModels.createModelReference(URI.parse(receipt.changeEditor.modified)));
			if (generation !== this.generation) { return; }
			this.diff.setModel({ original: original.object.textEditorModel, modified: modified.object.textEditorModel });
			this.previewNote.textContent = localize('changes.againstHead', "Changes against HEAD · Read Only");
		} catch (error) { if (generation === this.generation) { this.previewNote.textContent = String(error); this.models.clear(); } }
	}
	private validate(): void {
		const reason = commitDisabledReason(this.workspace, this.message.value, this.busy);
		this.commit.disabled = !!reason; this.reason.textContent = reason; this.message.disabled = this.busy;
		this.open.disabled = !this.selected || !this.workspace?.online || this.busy;
	}
	private async commitAll(): Promise<void> {
		if (commitDisabledReason(this.workspace, this.message.value, this.busy)) { return; }
		this.busy = true; this.error.textContent = ''; this.validate();
		try {
			await this.send({ version: 1, action: 'commitChanges', workspace: this.workspaceId, message: this.message.value, paths: this.files.map(file => file.path) });
			this.message.value = '';
		} catch (error) { this.error.textContent = String(error); }
		finally { this.busy = false; this.validate(); }
	}
	private async openEditor(): Promise<void> {
		if (this.open.disabled || !this.selected) { return; }
		try { await this.send({ version: 1, action: 'openChange', workspace: this.workspaceId, path: this.selected }); this.close(false); }
		catch (error) { this.error.textContent = String(error); }
	}
}
