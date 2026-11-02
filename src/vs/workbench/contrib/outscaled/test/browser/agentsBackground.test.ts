/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { backgroundAgents } from '../../browser/agentsBackgroundModel.js';
import { AgentSchedule, AgentsWorkspace, isAgentsSnapshot, isAgentsRequest } from '../../common/agentsBridge.js';
import { canLaunchAgents, defaultLaunch, parseAgentsCommand, insertLaunch } from '../../common/agentsLaunch.js';
import { presetLayout, removePane } from '../../common/agentsLayout.js';

suite('Outscaled - Background Agents', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const time = '2026-01-01T12:00:00.000Z';
	const schedule: AgentSchedule = { workspace: 'demo', name: 'claude-2', source: 'app', readOnly: false, runtime: 'claude-code', every: '30m', prompt: 'Check tests', command: null, paused: false, lastRun: null, nextRunAt: time };
	const workspace: AgentsWorkspace = { id: 'demo', name: 'demo', server: 'local', root: 'file:///test/demo', selected: true, online: true,
		layout: presetLayout('single', ['a']), terminals: [{ id: 'a', name: 'claude-1', runtime: 'claude-code', status: 'working', latestLine: 'Running tests' },
			{ id: 'b', name: 'shell-1', runtime: 'shell', status: 'idle', latestLine: 'Done' }] };
	test('strip is the complement of the grid for discovery, Move to Background and Replace View', () => {
		const ids = (layout: AgentsWorkspace['layout']) => backgroundAgents({ ...workspace, layout }).map(agent => agent.terminal);
		deepStrictEqual([ids(workspace.layout), ids(removePane(workspace.layout, 'a')), ids(insertLaunch(workspace.layout, presetLayout('single', ['b']), 'replace'))], [['b'], ['a', 'b'], ['a']]);
	});
	test('schedule cards before and after first run coalesce with terminals and follow grid membership', () => {
		const before = backgroundAgents({ ...workspace, schedules: [schedule] }).at(-1)!;
		deepStrictEqual({ name: before.name, prompt: before.schedule?.prompt, every: before.schedule?.every, next: before.schedule?.nextRunAt, editable: before.editable, terminal: before.terminal, disabled: !!before.openReason },
			{ name: 'claude-2', prompt: 'Check tests', every: '30m', next: time, editable: true, terminal: undefined, disabled: true });
		const running = { ...schedule, lastRun: { id: 'run', startedAt: time, endedAt: null, status: 'running' as const, result: '' } };
		const terminal = { ...workspace.terminals[0], id: 'scheduled', name: schedule.name, latestLine: 'Checking' };
		const withTerminal = { ...workspace, schedules: [running], terminals: [...workspace.terminals, terminal] };
		const model = backgroundAgents(withTerminal).at(-1)!;
		deepStrictEqual({ count: backgroundAgents(withTerminal).length, line: model.latestLine, status: model.status, disabled: !!model.runReason, open: model.openReason }, { count: 2, line: 'Checking', status: 'working', disabled: true, open: '' });
		strictEqual(backgroundAgents({ ...withTerminal, layout: presetLayout('single', [terminal.id]) }).some(agent => agent.schedule), false);
	});
	test('workspace schedules are read-only; paused, completed and offline fields explain actions', () => {
		const completed = { ...schedule, source: 'workspace' as const, readOnly: true, paused: true, nextRunAt: null,
			lastRun: { id: 'run', startedAt: time, endedAt: time, status: 'succeeded' as const, result: 'First result\nMore output' } };
		const model = backgroundAgents({ ...workspace, schedules: [completed] }).at(-1)!;
		deepStrictEqual({ editable: model.editable, reason: model.editReason, line: model.latestLine, next: model.next, run: model.runReason }, { editable: false, reason: 'Edit this schedule in .ws/workspace.toml.', line: 'First result', next: 'Paused', run: '' });
		const offline = backgroundAgents({ ...workspace, online: false, schedules: [completed] }).at(-1)!;
		deepStrictEqual([offline.openReason, offline.runReason], ['This workspace is offline.', 'This workspace is offline.']);
	});
	test('version 1 accepts optional schedule and latest line data, and rejects malformed fields', () => {
		const snapshot = { version: 1, workspaces: [{ ...workspace, schedules: [schedule] }] };
		strictEqual(isAgentsSnapshot(snapshot), true);
		for (const invalid of [{ ...schedule, readOnly: true }, { ...schedule, every: '0m' }, { ...schedule, prompt: 42 }, { ...schedule, nextRunAt: 'tomorrow' }, { ...schedule, lastRun: {} }]) {
			strictEqual(isAgentsSnapshot({ ...snapshot, workspaces: [{ ...workspace, schedules: [invalid] }] }), false);
		}
		for (const latestLine of ['', ' trailing ', 'two\nlines', 1, 'x'.repeat(201)]) {
			strictEqual(isAgentsSnapshot({ ...snapshot, workspaces: [{ ...workspace, terminals: [{ ...workspace.terminals[0], latestLine }] }] }), false);
		}
		for (const request of [{ action: 'openInGrid', terminal: 'a', focused: 'b' }, ...['run', 'pause', 'resume', 'delete'].map(operation => ({ action: 'schedule', name: 'claude-2', operation })), { action: 'editSchedule', name: 'claude-2', prompt: 'Check', every: '2h' }]) {
			strictEqual(isAgentsRequest({ version: 1, workspace: 'demo', ...request }), true);
		}
		for (const request of [{ action: 'openInGrid', terminal: 'a', focused: 2 }, { action: 'schedule', name: 'x', operation: 'exec' }, { action: 'editSchedule', name: 'x', prompt: '', every: '30m' }, { action: 'editSchedule', name: 'x', prompt: 'ok', every: '0m' }]) {
			strictEqual(isAgentsRequest({ version: 1, workspace: 'demo', ...request }), false);
		}
	});
	test('Scheduled dialog requires a prompt and agent panes, independently of Where and focus', () => {
		const { choices } = parseAgentsCommand('claude every 30m');
		deepStrictEqual([choices.run, choices.interval, canLaunchAgents(choices), canLaunchAgents({ ...choices, prompt: 'Check', where: 'right' }), canLaunchAgents({ ...choices, prompt: 'Check', agents: ['shell'] }), canLaunchAgents({ ...choices, prompt: 'Check', interval: 'bad' }), canLaunchAgents({ ...defaultLaunch(), where: 'right' })], ['scheduled', '30m', false, true, false, false, false]);
	});
});
