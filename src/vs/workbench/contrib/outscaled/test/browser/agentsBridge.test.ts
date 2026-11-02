/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentsSnapshot, isAgentsReceipt, isAgentsRequest, isAgentsSnapshot } from '../../common/agentsBridge.js';
import { isAgentsLayout, presetLayout } from '../../common/agentsLayout.js';

suite('Outscaled - Agents Bridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const snapshot: AgentsSnapshot = { version: 1, workspaces: [{ id: 'workspace', name: 'Demo', server: 'local', root: 'file:///test/demo', online: true, selected: true,
		layout: presetLayout('single', ['a']), terminals: [{ id: 'a', name: 'Claude', runtime: 'claude-code', status: 'idle', launch: { executable: '/test/ws', args: ['attach', 'demo', 'a'], env: {} } }] }] };
	test('accepts a complete snapshot and explicit versioned requests and receipts', () => {
		strictEqual(isAgentsSnapshot(snapshot), true);
		for (const request of [{ version: 1, action: 'newAgents' }, { version: 1, action: 'switch', workspace: 'demo' }, { version: 1, action: 'focus', workspace: 'demo', terminal: 'a' }]) { strictEqual(isAgentsRequest(request), true); }
		strictEqual(isAgentsReceipt({ version: 1, ok: true, panes: [{ workspace: 'demo', terminal: 'a', visible: true, processId: 42 }] }), true);
	});
	test('rejects wrong versions, malformed launches, duplicate identities and dangling membership', () => {
		for (const value of [null, {}, { ...snapshot, version: 2 }, { ...snapshot, workspaces: [snapshot.workspaces[0], snapshot.workspaces[0]] },
			{ ...snapshot, workspaces: [{ ...snapshot.workspaces[0], layout: presetLayout('single', ['missing']) }] },
			{ ...snapshot, workspaces: [{ ...snapshot.workspaces[0], terminals: [{ ...snapshot.workspaces[0].terminals[0], launch: { executable: 123 } }] }] },
			{ ...snapshot, workspaces: [{ ...snapshot.workspaces[0], terminals: [{ ...snapshot.workspaces[0].terminals[0], runtime: { toString: 1 } }] }] },
			{ ...snapshot, focus: { workspace: 'workspace', terminal: 'missing' } }]) { strictEqual(isAgentsSnapshot(value), false); }
		for (const value of [{ version: 2, action: 'newAgents' }, { version: 1, action: 'focus', workspace: 'demo' }, { version: 1, action: 'execute' }]) { strictEqual(isAgentsRequest(value), false); }
		strictEqual(isAgentsReceipt({ version: 1, ok: true, panes: [{ workspace: 'w', terminal: 't', visible: true, processId: -1 }] }), false);
		strictEqual(isAgentsLayout({ type: 'split', direction: 'right', children: [presetLayout('single', ['a']), presetLayout('single', ['a'])] }), false);
		const cycle = { type: 'split', direction: 'down', children: [] as object[] }; cycle.children.push(cycle, cycle);
		strictEqual(isAgentsLayout(cycle), false);
	});
});
