/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ITerminalEditorService, ITerminalInstance, TerminalEditorLocation } from '../../terminal/browser/terminal.js';
import { TerminalEditorService } from '../../terminal/browser/terminalEditorService.js';

const hosts = new Map<ITerminalInstance, () => Promise<void>>();

/** Keep native terminal commands that reveal an editor in the owning Agents view. */
export function registerAgentTerminalHost(instance: ITerminalInstance, reveal: () => Promise<void>): IDisposable {
	hosts.set(instance, reveal);
	return toDisposable(() => hosts.delete(instance));
}

/** Reuse native registration and active-instance routing, substituting only our panes' reveal. */
class AgentsTerminalEditorService extends TerminalEditorService {
	override async focusInstance(instance: ITerminalInstance): Promise<void> {
		const reveal = hosts.get(instance);
		if (!reveal) { return super.focusInstance(instance); }
		this.setActiveInstance(instance);
		await reveal();
		await instance.focusWhenReady(true);
	}

	override async openEditor(instance: ITerminalInstance, options?: TerminalEditorLocation): Promise<void> {
		const reveal = hosts.get(instance);
		if (!reveal) { return super.openEditor(instance, options); }
		await reveal();
	}

	override async revealActiveEditor(preserveFocus?: boolean): Promise<void> {
		const instance = this.activeInstance;
		const reveal = instance && hosts.get(instance);
		if (!reveal) { return super.revealActiveEditor(preserveFocus); }
		await reveal();
	}
}

registerSingleton(ITerminalEditorService, AgentsTerminalEditorService, InstantiationType.Delayed);
