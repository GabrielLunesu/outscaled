/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { z } from 'zod';
import { Health, LatestLine, ScheduleSummary, StreamMessage, Terminal, TerminalStatus, Workspace } from '@outscaled/protocol';

export interface ServerState {
	readonly host: string;
	online: boolean;
	error?: string;
	health?: Health;
	workspaces: Workspace[];
	terminals: Terminal[];
	schedules?: ScheduleSummary[];
}

/** Returns true when the notification requires an HTTP snapshot. */
export function applyMessage(state: ServerState, message: StreamMessage): boolean {
	if (message.type === 'workspace.changed' || message.type === 'run.started' || message.type === 'run.finished') { return true; }
	if (message.type === 'server.health') {
		state.health = Health.parse(message.payload);
	} else if (message.type === 'terminal.latest_line') {
		const terminal = state.terminals.find(t => t.id === message.terminal && t.workspace === message.workspace);
		if (!terminal) { return true; }
		terminal.latestLine = z.object({ latestLine: LatestLine }).parse(message.payload).latestLine;
	} else if (message.type === 'terminal.status') {
		const status = z.object({ newStatus: TerminalStatus }).safeParse(message.payload);
		if (!status.success) { throw new Error('Invalid terminal.status payload'); }
		const terminal = state.terminals.find(t => t.id === message.terminal);
		if (!terminal) { return true; }
		if (terminal.runtime && (!terminal.statusChangedAt || message.time >= terminal.statusChangedAt)) {
			terminal.status = status.data.newStatus;
			terminal.statusChangedAt = message.time;
		}
	}
	return false;
}
