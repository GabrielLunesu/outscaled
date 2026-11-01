/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Health, StreamMessage, Terminal, TerminalStatus, Workspace } from '@outscaled/protocol';

export interface ServerState {
	readonly host: string;
	online: boolean;
	error?: string;
	health?: Health;
	workspaces: Workspace[];
	terminals: Terminal[];
}

export function needsYou(terminals: readonly Terminal[]): number {
	return terminals.filter(t => t.state === 'running' && t.status === 'needs_input').length;
}

/** Returns true when the notification requires an HTTP snapshot. */
export function applyMessage(state: ServerState, message: StreamMessage): boolean {
	if (message.type === 'workspace.changed') return true;
	if (message.type === 'server.health') {
		state.health = Health.parse(message.payload);
	} else if (message.type === 'terminal.status' && 'terminal' in message) {
		const payload = message.payload;
		const status = TerminalStatus.safeParse(typeof payload === 'object' && payload !== null && 'newStatus' in payload ? payload.newStatus : undefined);
		if (!status.success) throw new Error('Invalid terminal.status payload');
		const terminal = state.terminals.find(t => t.id === message.terminal);
		if (!terminal) return true;
		if (terminal.runtime && (!terminal.statusChangedAt || message.time >= terminal.statusChangedAt)) {
			terminal.status = status.data;
			terminal.statusChangedAt = message.time;
		}
	}
	return false;
}
