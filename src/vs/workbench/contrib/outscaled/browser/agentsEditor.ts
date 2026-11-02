/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorExtensions, EditorInputCapabilities, IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AgentsBackground } from './agentsBackground.js';
import { WorkspaceTerminals } from './agentsService.js';

/** Disposable editor handle; never owns or disposes workspace terminals. */
export class AgentsInput extends EditorInput {
	static readonly ID = 'outscaled.agentsInput';
	readonly resource = undefined;
	constructor(readonly owner: WorkspaceTerminals) { super(); }
	override get typeId(): string { return AgentsInput.ID; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly | EditorInputCapabilities.ForceReveal; }
	override getName(): string { return localize('agents.editor', "Agents"); }
}

export class AgentsEditor extends EditorPane {
	static readonly ID = 'outscaled.agentsEditor';
	private host!: HTMLElement;
	private owner: WorkspaceTerminals | undefined;
	private background!: AgentsBackground;
	constructor(group: IEditorGroup, @ITelemetryService telemetry: ITelemetryService, @IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService, @IInstantiationService private readonly instantiation: IInstantiationService) { super(AgentsEditor.ID, group, telemetry, theme, storage); }
	protected createEditor(parent: HTMLElement): void {
		this.host = dom.append(parent, dom.$('.outscaled-agents-host'));
		this.background = this._register(this.instantiation.createInstance(AgentsBackground));
		const observer = new (dom.getWindow(parent).ResizeObserver)(() => this.owner?.layout());
		this._register({ dispose: () => observer.disconnect() });
		observer.observe(this.host);
		observer.observe(this.background.element);
	}
	override async setInput(input: AgentsInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.owner?.setVisible(false);
		this.owner = input.owner;
		this.background.close();
		this.host.replaceChildren(input.owner.element, this.background.element);
		input.owner.setVisible(this.isVisible());
		this.owner.layout();
	}
	override clearInput(): void { this.background.close(); this.owner?.setVisible(false); this.owner = undefined; super.clearInput(); }
	override setVisible(visible: boolean): void { super.setVisible(visible); if (!visible) { this.background.close(); } this.owner?.setVisible(visible); }
	layout(dimension: dom.Dimension): void {
		this.host.style.width = `${dimension.width}px`;
		this.host.style.height = `${dimension.height}px`;
		this.owner?.layout();
	}
	revealTerminal(terminal: string): void {
		if (this.owner?.hasVisiblePane(terminal)) { this.owner.focus(terminal); }
		else { this.background.openTerminal(terminal); }
	}
	override focus(): void { super.focus(); this.owner?.focus(); }
}
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentsEditor, AgentsEditor.ID, localize('agents.editorTitle', "Agents")), [new SyncDescriptor(AgentsInput)]);
