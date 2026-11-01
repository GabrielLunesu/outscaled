/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

interface INotifyRequest {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly processId?: number;
}

interface INotifyResult {
	readonly shown: boolean;
	readonly clicked: boolean;
}

/** Shows a needs-you toast and returns its outcome after handling a click. */
export async function showNotification(hostService: IHostService, terminalService: ITerminalService, request: unknown): Promise<INotifyResult> {
	if (!isNotifyRequest(request)) {
		return { shown: false, clicked: false };
	}
	const { id, title, body, processId } = request;
	// The host owns the native toast id; our stable id prevents duplicate live toasts.
	const result = await hostService.showToast({ dedupeKey: id, title, body }, CancellationToken.None);
	const shown = result.supported && !result.suppressed;
	const clicked = shown && result.clicked;
	if (clicked) {
		await hostService.focus(mainWindow, { mode: FocusMode.Force });
		const instance = processId === undefined ? undefined : terminalService.instances.find(instance => !instance.isDisposed && instance.processId === processId);
		if (instance) {
			// This reveals and focuses both panel and editor terminals.
			await terminalService.focusInstance(instance);
		}
	}
	return { shown, clicked };
}

/** Validates the untrusted argument supplied through the internal command. */
function isNotifyRequest(request: unknown): request is INotifyRequest {
	if (!request || typeof request !== 'object') {
		return false;
	}
	const candidate = request as Partial<INotifyRequest>;
	return typeof candidate.id === 'string' && candidate.id.trim().length > 0 &&
		typeof candidate.title === 'string' && candidate.title.trim().length > 0 &&
		typeof candidate.body === 'string' &&
		(candidate.processId === undefined || (Number.isSafeInteger(candidate.processId) && candidate.processId > 0));
}
