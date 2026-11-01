/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal } from '@outscaled/protocol';
export type TabStatus = 'idle' | 'working' | 'needs_input' | 'crashed';
export function tabStatus(terminal: Pick<Terminal, 'state' | 'runtime' | 'status'>): TabStatus {
	if (terminal.state === 'exited') return 'idle';
	if (terminal.state === 'crashed') return 'crashed';
	if (!terminal.runtime) return 'idle';
	if (terminal.status === 'working' || terminal.status === 'starting') return 'working';
	return terminal.status === 'needs_input' ? 'needs_input' : 'idle';
}
/** Cache only acknowledged updates; serialize callers so an older update cannot win. */
export class TabStatusChanges {
	private readonly sent = new Map<number, TabStatus>();
	async update(processId: number, terminal: Pick<Terminal, 'state' | 'runtime' | 'status'>,
		send: (request: { processId: number; status: TabStatus }) => PromiseLike<boolean | undefined>): Promise<void> {
		const status = tabStatus(terminal);
		if (this.sent.get(processId) === status) return;
		if (await send({ processId, status })) this.sent.set(processId, status);
	}
	forget(processId: number): void { this.sent.delete(processId); }
}
