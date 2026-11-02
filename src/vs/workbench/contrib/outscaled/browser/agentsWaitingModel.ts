/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { AgentPane, AgentsSnapshot } from '../common/agentsBridge.js';

/** The question on the screen is more specific than the Notification hook's message. */
export function agentRequestText(pane: AgentPane): string {
	return pane.status === 'needs_input' ? pane.request?.permission?.question || pane.request?.message || localize('waiting.input', "Needs your input") : '';
}

/** Only recognised Claude prompts with exact, unambiguous Yes and No choices offer answers. */
export function canAnswerAgent(pane: AgentPane): boolean {
	const options = pane.request?.permission?.options ?? [];
	return pane.status === 'needs_input' && pane.runtime === 'claude-code' &&
		options.filter(option => option.label === 'Yes').length === 1 && options.filter(option => option.label === 'No').length === 1;
}

/** Stable identities include the workspace because different servers may reuse terminal ids. */
export function waitingAgents(snapshot: AgentsSnapshot) {
	return snapshot.workspaces.flatMap(workspace => workspace.terminals.filter(pane => pane.status === 'needs_input').map(pane => ({
		key: JSON.stringify([workspace.id, pane.id]), workspace, pane, text: agentRequestText(pane), canAnswer: canAnswerAgent(pane)
	}))).sort((a, b) => (Date.parse(a.pane.statusChangedAt ?? '') || 0) - (Date.parse(b.pane.statusChangedAt ?? '') || 0) ||
		a.key.localeCompare(b.key));
}
export type WaitingAgent = ReturnType<typeof waitingAgents>[number];

/** A removed cursor restarts at the oldest request; an unchanged list wraps around. */
export function nextWaitingAgent(snapshot: AgentsSnapshot, previous?: string): WaitingAgent | undefined {
	const waiting = waitingAgents(snapshot);
	return waiting[(waiting.findIndex(agent => agent.key === previous) + 1) % waiting.length];
}
