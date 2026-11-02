/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pathToFileURL } from 'node:url';
import { hostAuthority } from '../daemon/servers';
import type { AgentsSnapshot } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsBridge.js';
import { AgentsLayout, presetLayout, layoutTerminals, splitPane } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLayout.js';
import type { ServerState } from '../daemon/state';
import type { SelectedWorkspace } from '../workspaces/selection';
import { workspaceKey } from '../workspaces/identity';
import { GridMemory } from './memory';
import { attachArgs } from './wsPath';
import { tabStatus } from './status';

/** Keep initial discovery shallow even when a server already has many running sessions. */
function discoveredLayout(ids: string[]): AgentsLayout {
	if (ids.length <= 1) { return presetLayout('single', ids); }
	const children: AgentsLayout[] = ids.length <= 64 ? ids.map(terminal => ({ type: 'pane', terminal }))
		: Array.from({ length: Math.ceil(ids.length / 64) }, (_, index) => discoveredLayout(ids.slice(index * 64, (index + 1) * 64)));
	return { type: 'split', direction: 'right', children };
}

/** Pure daemon-to-view mapping, including VPS launch arguments. Offline snapshots retain membership. */
export function agentsSnapshot(servers: readonly ServerState[], selected: SelectedWorkspace | undefined, memory: GridMemory,
	executable: string | undefined, env: Record<string, string>, branches: ReadonlyMap<string, string> = new Map()): AgentsSnapshot {
	return { version: 1, workspaces: servers.flatMap(server => server.workspaces.map(workspace => {
		const location = { host: server.host, slug: workspace.slug };
		const id = workspaceKey(location);
		const schedules = (server.schedules ?? []).filter(schedule => schedule.workspace === workspace.slug);
		const scheduledNames = new Set(schedules.map(schedule => schedule.name));
		const terminals = server.terminals.filter(terminal => terminal.workspace === workspace.slug);
		const root = server.host === 'local' ? pathToFileURL(workspace.path).href : `ws://${hostAuthority(server.host)}/${encodeURIComponent(workspace.slug)}/`;
		let layout = memory.reconcile(location, new Set(terminals.map(terminal => terminal.id))) ?? presetLayout('single', []);
		// Daemon-created terminals join the grid without replacing existing members.
		const placed = new Set([...layoutTerminals(layout), ...memory.known(location)]);
		const discovered = terminals.filter(terminal => terminal.state === 'running' && !terminal.alwaysOn && !scheduledNames.has(terminal.name) && !placed.has(terminal.id));
		if (!layoutTerminals(layout).length && discovered.length) {
			layout = discoveredLayout(discovered.map(terminal => terminal.id));
			for (const terminal of discovered) { placed.add(terminal.id); }
		}
		for (const terminal of terminals.filter(terminal => terminal.state === 'running' && !terminal.alwaysOn && !scheduledNames.has(terminal.name))) {if (!placed.has(terminal.id)) {
			const last = layoutTerminals(layout).at(-1);
			layout = last ? splitPane(layout, last, terminal.id, 'right') : presetLayout('single', [terminal.id]);
			placed.add(terminal.id);
		}}
		return { id, name: workspace.slug, server: server.host, root, path: workspace.path, selected: !!selected && id === workspaceKey(selected), online: server.online,
			branch: branches.get(id), layout, schedules, terminals: terminals.map(terminal => ({ id: terminal.id, name: terminal.name,
				runtime: terminal.runtime === 'claude-code' || terminal.runtime === 'codex' ? terminal.runtime : 'shell', status: tabStatus(terminal), latestLine: terminal.latestLine,
				...(executable && terminal.state === 'running' ? { launch: { executable, args: attachArgs(server.host, workspace.slug, terminal.name), env } } : {}) })) };
	})) };
}
