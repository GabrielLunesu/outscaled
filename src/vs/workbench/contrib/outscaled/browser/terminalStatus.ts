/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { TerminalIcon } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance } from '../../terminal/browser/terminal.js';

export type TerminalStatus = 'idle' | 'working' | 'needs_input' | 'crashed';

export interface ISetTerminalStatusRequest {
	processId: number;
	status: TerminalStatus | null;
}

type StatusTerminal = Pick<ITerminalInstance, 'processId' | 'icon' | 'color' | 'changeIcon' | 'changeColor' | 'isDisposed'>;

interface ITerminalAppearance {
	icon: TerminalIcon;
	color: string | undefined;
}

const appearances: Record<TerminalStatus, ITerminalAppearance> = {
	idle: { icon: Codicon.circleFilled, color: 'terminal.ansiBrightBlack' },
	working: { icon: ThemeIcon.modify(Codicon.loading, 'spin'), color: 'terminal.ansiGreen' },
	needs_input: { icon: Codicon.circleFilled, color: 'terminal.ansiRed' },
	crashed: { icon: Codicon.close, color: 'terminal.ansiRed' }
};

/** Applies live tab status to panel and editor terminals without opening an icon or color picker. */
export class TerminalStatusController {
	private readonly originals = new WeakMap<StatusTerminal, ITerminalAppearance>();

	async setStatus(instances: readonly StatusTerminal[], request: ISetTerminalStatusRequest, defaultIcon: TerminalIcon): Promise<boolean> {
		if (!request || !Number.isSafeInteger(request.processId) || request.processId <= 0 ||
			(request.status !== null && request.status !== 'idle' && request.status !== 'working' && request.status !== 'needs_input' && request.status !== 'crashed')) {
			return false;
		}
		const instance = instances.find(instance => !instance.isDisposed && instance.processId === request.processId);
		if (!instance) {
			return false;
		}

		// These APIs deliberately persist an icon/color override. The extension reapplies live status
		// after reload; originals live only in this window, so a reset without a snapshot is a no-op.
		let original = this.originals.get(instance);
		if (request.status !== null && !original) {
			original = { icon: instance.icon ?? defaultIcon, color: instance.color };
			this.originals.set(instance, original);
		}
		const appearance = request.status === null ? original : appearances[request.status];
		if (appearance) {
			// Both methods apply explicit values synchronously before returning their promises, keeping
			// rapid updates in order. Never pass undefined to changeIcon: that opens the icon picker.
			await Promise.all([
				instance.changeIcon(appearance.icon),
				instance.changeColor(appearance.color, true)
			]);
		}
		return true;
	}
}
