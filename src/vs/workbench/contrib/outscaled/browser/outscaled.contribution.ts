/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable header/header -- Outscaled sources carry Gabriel Lunesu's copyright. */

// eslint-disable-next-line local/code-translation-remind -- Keep this fork contribution independent of upstream build resources.
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ITerminalProfileResolverService } from '../../terminal/common/terminal.js';
import { ISetTerminalStatusRequest, TerminalStatus, TerminalStatusController } from './terminalStatus.js';
import './media/terminalStatus.css';

const controller = new TerminalStatusController();

CommandsRegistry.registerCommand('_outscaled.setTerminalStatus', (accessor, request: ISetTerminalStatusRequest) => {
	return controller.setStatus(accessor.get(ITerminalService).instances, request, accessor.get(ITerminalProfileResolverService).getDefaultIcon());
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'outscaled.setActiveTerminalStatus',
			title: localize2('outscaled.setActiveTerminalStatus', "Outscaled: Set Active Terminal Status"),
			category: Categories.Developer,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const quickInputService = accessor.get(IQuickInputService);
		const defaultIcon = accessor.get(ITerminalProfileResolverService).getDefaultIcon();
		const instance = terminalService.activeInstance;
		if (!instance?.processId) {
			return;
		}
		const items: (IQuickPickItem & { status: TerminalStatus | null })[] = [
			{ label: localize('outscaled.status.working', "Working"), status: 'working' },
			{ label: localize('outscaled.status.needsInput', "Needs Input"), status: 'needs_input' },
			{ label: localize('outscaled.status.idle', "Idle"), status: 'idle' },
			{ label: localize('outscaled.status.crashed', "Crashed"), status: 'crashed' },
			{ label: localize('outscaled.status.reset', "Reset"), status: null }
		];
		const pick = await quickInputService.pick(items, {
			placeHolder: localize('outscaled.status.pick', "Select the active terminal's agent status")
		});
		if (pick) {
			await controller.setStatus(terminalService.instances, { processId: instance.processId, status: pick.status }, defaultIcon);
		}
	}
});
