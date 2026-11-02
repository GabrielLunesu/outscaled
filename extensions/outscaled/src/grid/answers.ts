/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';
import { TerminalAnswer } from '@outscaled/protocol';
import type { DaemonService } from '../daemon/service';
import type { WorkspaceLocation } from '../workspaces/uri';

/** Only the daemon may choose a key: it rechecks the current screen against the captured request. */
export async function answerTerminal(service: Pick<DaemonService, 'request' | 'synchronize'>, workspace: WorkspaceLocation,
	name: string, answer: 'allow_once' | 'deny', jump: () => Promise<void>, inform: (message: string) => void): Promise<'answered' | 'jumped'> {
	const response = await service.request(workspace.host, `workspaces/${encodeURIComponent(workspace.slug)}/terminals/${encodeURIComponent(name)}/answer`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer })
	});
	if (response.status === 409) {
		await jump();
		inform(l10n.t('The permission prompt changed or is no longer on screen. Review the agent to continue.'));
		return 'jumped';
	}
	if (!response.ok) { throw new Error(l10n.t('Could not answer the agent (HTTP {0})', response.status)); }
	TerminalAnswer.parse(await response.json());
	await service.synchronize(workspace.host);
	return 'answered';
}
