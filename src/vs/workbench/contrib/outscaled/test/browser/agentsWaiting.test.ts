/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentRequestText, canAnswerAgent, nextWaitingAgent, waitingAgents } from '../../browser/agentsWaitingModel.js';
import { AgentPane, AgentsSnapshot, isAgentsRequest, isAgentsSnapshot } from '../../common/agentsBridge.js';

suite('Outscaled - Waiting Agents', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const permission = { question: 'Do you want to create notes.txt?', options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'Yes, always' }, { number: 3, label: 'No' }] };
	const pane: AgentPane = { id: 'same-id', name: 'claude-1', runtime: 'claude-code', status: 'needs_input', statusChangedAt: '2026-01-01T12:00:00.000Z', request: { message: 'Permission required', permission } };
	const snapshot: AgentsSnapshot = { version: 1, workspaces: ['newer', 'older'].map((id, index) => ({ id, name: id, server: 'local', root: 'file:///test/' + id, selected: !index, online: true,
		layout: { type: 'pane', terminal: index ? null : pane.id }, terminals: [{ ...pane, statusChangedAt: index ? '2026-01-01T11:00:00.000Z' : pane.statusChangedAt }] })) };
	test('orders across workspaces and cycles independently of grid membership and selection', () => {
		const waiting = waitingAgents(snapshot);
		deepStrictEqual(waiting.map(row => row.workspace.id), ['older', 'newer']);
		deepStrictEqual([nextWaitingAgent(snapshot)?.key, nextWaitingAgent(snapshot, waiting[0].key)?.key, nextWaitingAgent(snapshot, waiting[1].key)?.key,
			nextWaitingAgent(snapshot, 'removed')?.key, nextWaitingAgent({ version: 1, workspaces: [] })?.key], [waiting[0].key, waiting[1].key, waiting[0].key, waiting[0].key, undefined]);
	});
	test('stable tie ordering does not depend on discovery order; nonwaiting agents are absent', () => {
		const tied = structuredClone(snapshot); tied.workspaces[1].terminals[0].statusChangedAt = pane.statusChangedAt;
		deepStrictEqual(waitingAgents(tied).map(row => row.key), waitingAgents({ ...tied, workspaces: [...tied.workspaces].reverse() }).map(row => row.key));
		tied.workspaces[0].terminals[0].status = 'idle';
		deepStrictEqual(waitingAgents(tied).map(row => row.workspace.id), ['older']);
	});
	test('uses the permission question, then notification text, then a localized fallback; clears outside waiting', () => {
		deepStrictEqual([agentRequestText(pane), agentRequestText({ ...pane, request: { message: 'Which branch?', permission: null } }),
			agentRequestText({ ...pane, request: null }), agentRequestText({ ...pane, status: 'working' })], [permission.question, 'Which branch?', 'Needs your input', '']);
	});
	test('answers only waiting Claude permission prompts with exact Yes and No options', () => {
		deepStrictEqual([pane, { ...pane, runtime: 'codex' as const }, { ...pane, status: 'idle' as const }, { ...pane, request: null },
			{ ...pane, request: { message: null, permission: { ...permission, options: [{ number: 1, label: 'Yes, always' }, { number: 4, label: 'No' }] } } }].map(canAnswerAgent), [true, false, false, false, false]);
	});
	test('version 1 validates request, timestamp and answer fields and accepts older snapshots', () => {
		strictEqual(isAgentsSnapshot(snapshot), true);
		for (const change of [{ request: { message: 42, permission: null } }, { request: { message: null, permission: { question: '', options: [] } } },
			{ request: { message: null, permission: { ...permission, options: [{ number: 10, label: 'Yes' }, { number: 1, label: 'No' }] } } },
			{ request: { message: null, permission: { ...permission, options: [{ number: 1, label: 'Yes' }, { number: 1, label: 'No' }] } } }, { statusChangedAt: 'bad' }]) {
			const invalid = structuredClone(snapshot); Object.assign(invalid.workspaces[0].terminals[0], change); strictEqual(isAgentsSnapshot(invalid), false);
		}
		for (const answer of ['allow_once', 'deny']) { strictEqual(isAgentsRequest({ version: 1, action: 'answer', workspace: 'w', terminal: 't', answer }), true); }
		for (const change of [{ answer: 'allow_always' }, { answer: 1 }, { terminal: '' }, { workspace: null }]) { strictEqual(isAgentsRequest({ version: 1, action: 'answer', workspace: 'w', terminal: 't', answer: 'deny', ...change }), false); }
	});
});
