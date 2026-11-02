/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { changesModel, changeStatusLabel, commitDisabledReason, inferredChangeExplanation } from '../../browser/agentsChangesModel.js';
import { codeRailAgents, codeViews } from '../../browser/agentsCodeModel.js';
import { AgentChanges, AgentsWorkspace, isAgentChangeEditor, isAgentsReceipt, isAgentsRequest, isAgentsSnapshot } from '../../common/agentsBridge.js';

suite('Outscaled - Changes and Code', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const changes: AgentChanges = { attributionAvailable: true, files: [
		{ path: 'z.ts', originalPath: null, status: 'untracked', agents: [] },
		{ path: 'new.ts', originalPath: 'old.ts', status: 'renamed', agents: [
			{ terminal: 'claude', runtime: 'claude-code', time: '2026-01-01T00:00:00.000Z', inferred: false },
			{ terminal: 'codex', runtime: 'codex', time: '2026-01-02T00:00:00.000Z', inferred: true }] },
		{ path: 'a.ts', originalPath: null, status: 'modified', agents: [] }
	] };
	const workspace: AgentsWorkspace = { id: 'w', name: 'demo', server: 'local', root: 'file:///test/demo', selected: true, online: true, layout: { type: 'pane', terminal: null }, terminals: [], changes };
	test('orders files and attribution newest first, leaves unattributed files last by path and preserves status', () => {
		const model = changesModel(workspace);
		deepStrictEqual(model.files.map(file => [file.path, file.originalPath, file.status, file.agents.map(agent => [agent.terminal, agent.inferred])]), [
			['new.ts', 'old.ts', 'renamed', [['codex', true], ['claude', false]]], ['a.ts', null, 'modified', []], ['z.ts', null, 'untracked', []]
		]);
		strictEqual(changes.files[1].agents[0].terminal, 'claude');
		deepStrictEqual((['modified', 'added', 'deleted', 'renamed', 'untracked'] as const).map(changeStatusLabel), ['Modified', 'Added', 'Deleted', 'Renamed', 'Untracked']);
		strictEqual(inferredChangeExplanation.includes('Concurrent'), true);
	});
	test('unavailable attribution retains files with a single workspace explanation; VPS limits are explicit', () => {
		const model = changesModel({ ...workspace, root: 'ws://example/demo/', changes: { ...changes, attributionAvailable: false } });
		deepStrictEqual([model.files.length, model.unavailable, model.remote, !!model.unavailableLabel, model.note.includes('come later')], [3, true, true, true, true]);
		strictEqual(commitDisabledReason({ ...workspace, root: 'ws://example/demo/' }, 'message', false), 'Commit for VPS workspaces comes later.');
	});
	test('commit disable reasons cover loading, offline, errors, empty state and empty message', () => {
		deepStrictEqual([commitDisabledReason(workspace, 'message', false), commitDisabledReason(workspace, ' \n ', false),
			commitDisabledReason({ ...workspace, changes: { attributionAvailable: true, files: [] } }, 'message', false),
			commitDisabledReason({ ...workspace, online: false }, 'message', false), commitDisabledReason({ ...workspace, changesError: 'Git failed' }, 'message', false), commitDisabledReason(workspace, 'message', true)],
		['', 'Enter a commit message.', 'No changes to commit.', 'The workspace is offline.', 'Git failed', 'Committing…']);
	});
	test('version 1 accepts older snapshots and validates every optional changes field', () => {
		const snapshot = { version: 1, workspaces: [workspace] };
		strictEqual(isAgentsSnapshot(snapshot), true);
		strictEqual(isAgentsSnapshot({ ...snapshot, workspaces: [{ ...workspace, changes: undefined }] }), true);
		for (const file of [{ ...changes.files[0], status: 'conflict' }, { ...changes.files[0], path: '../outside' }, { ...changes.files[0], originalPath: '/absolute' },
			{ ...changes.files[1], agents: [{ ...changes.files[1].agents[0], inferred: 'yes' }] }, { ...changes.files[1], agents: [{ ...changes.files[1].agents[0], time: 'bad' }] }]) {
			strictEqual(isAgentsSnapshot({ ...snapshot, workspaces: [{ ...workspace, changes: { attributionAvailable: true, files: [file] } }] }), false);
		}
		strictEqual(isAgentsSnapshot({ ...snapshot, workspaces: [{ ...workspace, changes: { ...changes, files: [changes.files[0], changes.files[0]] } }] }), false);
	});
	test('commit requests reject empty messages, NUL, duplicate, empty and unsafe paths', () => {
		const request = { version: 1, action: 'commitChanges', workspace: 'w', message: 'Commit files', paths: ['a.ts', 'space in name.ts'] };
		strictEqual(isAgentsRequest(request), true);
		for (const invalid of [{ message: ' \n' }, { message: 'bad\0message' }, { message: 'x'.repeat(32769) }, { paths: [] }, { paths: ['a', 'a'] }, { paths: ['/absolute'] }, { paths: ['../outside'] }, { paths: ['a/./b'] }, { paths: ['a\\b'] }, { paths: [1] }, { workspace: '' }]) { strictEqual(isAgentsRequest({ ...request, ...invalid }), false); }
		deepStrictEqual(['changeDiff', 'openChange'].map(action => isAgentsRequest({ version: 1, action, workspace: 'w', path: 'a.ts' })), [true, true]);
	});
	test('editor receipts reject invalid schemes and malformed resources', () => {
		const editor = { original: 'git:/test?ref=HEAD', modified: 'file:///test', label: 'test (Changes)' };
		strictEqual(isAgentsReceipt({ version: 1, ok: true, changeEditor: editor }), true);
		deepStrictEqual([{ ...editor, original: 'https://example.test' }, { ...editor, modified: 'command:run' }, { ...editor, label: '' }, { ...editor, original: undefined }, { ...editor, original: 'git:relative' }, { ...editor, modified: 'file:/bad\0path' }].map(isAgentChangeEditor), [false, false, false, false, false, false]);
	});
	test('rail includes grid terminals, background terminals and schedules before their first run', () => {
		const rail = codeRailAgents({ ...workspace, terminals: [
			{ id: 'grid', name: 'grid-agent', runtime: 'claude-code', status: 'working' }, { id: 'background', name: 'background-agent', runtime: 'codex', status: 'needs_input' }
		], layout: { type: 'pane', terminal: 'grid' }, schedules: [{ workspace: 'demo', name: 'check', runtime: 'codex', source: 'app', readOnly: false,
			every: '1d', prompt: 'Check', command: null, paused: false, nextRunAt: null, lastRun: null }] });
		deepStrictEqual(rail.map(agent => [agent.id, agent.terminal, agent.status]), [['terminal:grid', 'grid', 'working'], ['terminal:background', 'background', 'needs_input'], ['schedule:check', undefined, 'idle']]);
	});
	test('switcher exposes the five native views and their shortcut command IDs', () => {
		deepStrictEqual(codeViews.map(view => [view.id, view.command, view.label]), [
			['workbench.view.explorer', 'workbench.view.explorer', 'Explorer'], ['workbench.view.search', 'workbench.view.search', 'Search'],
			['workbench.view.scm', 'workbench.view.scm', 'Source Control'], ['workbench.view.debug', 'workbench.view.debug', 'Run and Debug'],
			['workbench.view.extensions', 'workbench.view.extensions', 'Extensions']
		]);
	});
});
