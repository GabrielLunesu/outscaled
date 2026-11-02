/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { AgentStatus, AgentsSnapshot } from '../common/agentsBridge.js';

export function agentStatusLabel(status: AgentStatus): string {
	return { idle: localize('agents.idle', "Idle"), working: localize('agents.working', "Working"), needs_input: localize('agents.needsInput', "Needs You"), crashed: localize('agents.crashed', "Crashed") }[status];
}

/** Preserve bridge order, including offline workspaces and terminals outside the grid. */
export function workspaceRows(snapshot: AgentsSnapshot, label: (resource: URI) => string) {
	return snapshot.workspaces.map(workspace => {
		const path = workspace.server === 'local' ? label(URI.parse(workspace.root)) : workspace.path ?? URI.parse(workspace.root).path;
		const detail = [workspace.server !== 'local' ? workspace.server : undefined,
			!workspace.online ? localize('agents.sidebar.offline', "Offline") : undefined, path, workspace.branch].filter(Boolean).join(' · ');
		const waiting = workspace.terminals.filter(terminal => terminal.status === 'needs_input').length;
		const dots = workspace.terminals.map(terminal => ({ id: terminal.id, status: terminal.status,
			label: localize('agents.sidebar.agentStatus', "{0}: {1}", terminal.name, agentStatusLabel(terminal.status)) }));
		return { id: workspace.id, name: workspace.name, selected: workspace.selected, online: workspace.online, detail, waiting, dots,
			label: localize('agents.sidebar.row', "{0}, {1}, {2} agents need you. {3}", workspace.name, detail, waiting, dots.map(dot => dot.label).join(', ')) };
	});
}
export type WorkspaceRow = ReturnType<typeof workspaceRows>[number];

/** Numbers are one-based and always address the current bridge order, in either mode. */
export function workspaceForShortcut(snapshot: AgentsSnapshot, number: number): string | undefined {
	return Number.isInteger(number) && number >= 1 && number <= 9 ? snapshot.workspaces[number - 1]?.id : undefined;
}
