/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Terminal } from '@outscaled/protocol';
import type { DaemonService } from '../daemon/service';
import type { WorkspaceLocation } from '../workspaces/uri';
import type { GridPane } from './presets';

type Requester = Pick<DaemonService, 'request'>;
async function list(service: Requester, workspace: WorkspaceLocation): Promise<Terminal[]> {
	const response = await service.request(workspace.host, `workspaces/${encodeURIComponent(workspace.slug)}/terminals`);
	if (!response.ok) throw new Error(`Could not list terminals (HTTP ${response.status})`);
	return Terminal.array().parse(await response.json());
}
/** Query fresh membership rather than trusting a potentially in-flight stream snapshot. */
export async function ensureTerminal(service: Requester, workspace: WorkspaceLocation, pane: Pick<GridPane, 'name' | 'command'>): Promise<Terminal> {
	const running = (terminals: Terminal[]) => terminals.find(terminal => terminal.name === pane.name && terminal.state === 'running');
	const existing = running(await list(service, workspace));
	if (existing) return existing;
	const response = await service.request(workspace.host, `workspaces/${encodeURIComponent(workspace.slug)}/terminals`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: pane.name, command: pane.command })
	});
	if (response.ok) return Terminal.parse(await response.json());
	// Another client may have won the create race. Reuse only a running terminal.
	if (response.status === 409) {
		const winner = running(await list(service, workspace));
		if (winner) return winner;
	}
	throw new Error(`Could not open ${pane.name} (HTTP ${response.status})`);
}
