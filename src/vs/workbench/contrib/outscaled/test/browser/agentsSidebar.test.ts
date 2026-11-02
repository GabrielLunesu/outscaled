/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentsSnapshot, AgentsWorkspace, AgentStatus } from '../../common/agentsBridge.js';
import { presetLayout } from '../../common/agentsLayout.js';
import { workspaceForShortcut, workspaceRows } from '../../browser/agentsSidebarModel.js';

suite('Outscaled - Workspace Sidebar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const workspace: AgentsWorkspace = { id: 'local', name: 'Demo', root: 'file:///home/test/demo', server: 'local', online: true, selected: true,
		branch: 'main', layout: presetLayout('single', []), terminals: [] };
	const label = (uri: URI) => uri.path.replace('/home/test/', '~/');

	test('keeps bridge and terminal order, counts only waiting agents and exposes all dot states', () => {
		const statuses: AgentStatus[] = ['idle', 'working', 'needs_input', 'crashed', 'needs_input'];
		const snapshot: AgentsSnapshot = { version: 1, workspaces: [
			{ ...workspace, id: 'second', selected: false },
			{ ...workspace, terminals: statuses.map((status, index) => ({ id: String(index), name: `Agent ${index}`, runtime: 'codex', status })) }
		] };
		deepStrictEqual(workspaceRows(snapshot, label).map(row => ({ id: row.id, waiting: row.waiting, selected: row.selected, dots: row.dots })), [
			{ id: 'second', waiting: 0, selected: false, dots: [] },
			{ id: 'local', waiting: 2, selected: true, dots: [
				{ id: '0', status: 'idle', label: 'Agent 0: Idle' }, { id: '1', status: 'working', label: 'Agent 1: Working' },
				{ id: '2', status: 'needs_input', label: 'Agent 2: Needs You' }, { id: '3', status: 'crashed', label: 'Agent 3: Crashed' },
				{ id: '4', status: 'needs_input', label: 'Agent 4: Needs You' }
			] }
		]);
	});
	test('formats local home paths, branches, actual VPS paths and offline servers', () => {
		const remote = { ...workspace, server: 'example-alias', root: 'ws://example-alias/demo/', path: '/workspaces/demo', selected: false };
		deepStrictEqual(workspaceRows({ version: 1, workspaces: [workspace, { ...workspace, branch: undefined }, remote,
			{ ...remote, online: false, branch: undefined }, { ...remote, path: undefined }, { ...workspace, online: false }] }, label)
			.map(row => ({ detail: row.detail, online: row.online })), [
			{ detail: '~/demo · main', online: true }, { detail: '~/demo', online: true },
			{ detail: 'example-alias · /workspaces/demo · main', online: true }, { detail: 'example-alias · Offline · /workspaces/demo', online: false },
			{ detail: 'example-alias · /demo/ · main', online: true }, { detail: 'Offline · ~/demo · main', online: false }
		]);
	});
	test('maps one through nine to current bridge order; missing and invalid slots do nothing', () => {
		const snapshot: AgentsSnapshot = { version: 1, workspaces: Array.from({ length: 10 }, (_, index) => ({ ...workspace, id: String(10 - index) })) };
		deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1.5, NaN].map(number => workspaceForShortcut(snapshot, number)),
			[undefined, '10', '9', '8', '7', '6', '5', '4', '3', '2', undefined, undefined, undefined]);
		deepStrictEqual([workspaceForShortcut({ version: 1, workspaces: [workspace] }, 2), workspaceForShortcut({ version: 1, workspaces: [] }, 1), workspaceRows({ version: 1, workspaces: [] }, label)], [undefined, undefined, []]);
	});
});
