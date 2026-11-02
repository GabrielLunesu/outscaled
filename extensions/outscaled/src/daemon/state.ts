/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { z } from 'zod';
import { Health, LatestLine, ScheduleSummary, StreamMessage, Terminal, TerminalStatus, TerminalRequest, Workspace, WorkspaceChanges } from '@outscaled/protocol';

export interface ServerState {
	readonly host: string;
	online: boolean;
	error?: string;
	health?: Health;
	workspaces: Workspace[];
	terminals: Terminal[];
	schedules?: ScheduleSummary[];
	changes?: Record<string, WorkspaceChanges>;
	changesErrors?: Record<string, string>;
}

/** Returns true when the notification requires an HTTP snapshot. */
export function applyMessage(state: ServerState, message: StreamMessage): boolean {
	if (message.type === 'workspace.changed' || message.type === 'workspace.changes' || message.type === 'run.started' || message.type === 'run.finished') { return true; }
	if (message.type === 'server.health') {
		state.health = Health.parse(message.payload);
	} else if (message.type === 'terminal.latest_line') {
		const terminal = state.terminals.find(t => t.id === message.terminal && t.workspace === message.workspace);
		if (!terminal) { return true; }
		terminal.latestLine = z.object({ latestLine: LatestLine }).parse(message.payload).latestLine;
	} else if (message.type === 'terminal.status') {
		const status = z.object({ newStatus: TerminalStatus, request: TerminalRequest.nullable().optional() }).safeParse(message.payload);
		if (!status.success) { throw new Error('Invalid terminal.status payload'); }
		const terminal = state.terminals.find(t => t.id === message.terminal && t.workspace === message.workspace);
		if (!terminal) { return true; }
		if (terminal.runtime && (!terminal.statusChangedAt || message.time >= terminal.statusChangedAt)) {
			if (terminal.status !== status.data.newStatus || !terminal.statusChangedAt) { terminal.statusChangedAt = message.time; }
			terminal.status = status.data.newStatus;
			terminal.request = status.data.newStatus === 'needs_input' ? status.data.request ?? null : null;
		}
	}
	return false;
}
