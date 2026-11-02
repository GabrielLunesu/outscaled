/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentsWorkspace } from '../common/agentsBridge.js';
import { layoutTerminals } from '../common/agentsLayout.js';
import { agentRuntimeLabel, backgroundAgents } from './agentsBackgroundModel.js';
import { Codicon } from '../../../../base/common/codicons.js';
// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';

/** Native containers and their existing command bindings, replacing activity-bar navigation. */
export const codeViews = [
	{ id: 'workbench.view.explorer', command: 'workbench.view.explorer', label: localize('code.explorer', "Explorer"), icon: Codicon.files },
	{ id: 'workbench.view.search', command: 'workbench.view.search', label: localize('code.search', "Search"), icon: Codicon.search },
	{ id: 'workbench.view.scm', command: 'workbench.view.scm', label: localize('code.scm', "Source Control"), icon: Codicon.sourceControl },
	{ id: 'workbench.view.debug', command: 'workbench.view.debug', label: localize('code.debug', "Run and Debug"), icon: Codicon.debugAlt },
	{ id: 'workbench.view.extensions', command: 'workbench.view.extensions', label: localize('code.extensions', "Extensions"), icon: Codicon.extensions }
] as const;

/** Include schedules before their first run as well as grid and background terminals. */
export function codeRailAgents(workspace: AgentsWorkspace | undefined) {
	if (!workspace) { return []; }
	const grid = new Set(layoutTerminals(workspace.layout));
	return [...workspace.terminals.filter(terminal => grid.has(terminal.id)).map(terminal => ({
		id: `terminal:${terminal.id}`, terminal: terminal.id, name: terminal.name, status: terminal.status, runtime: agentRuntimeLabel(terminal.runtime)
	})), ...backgroundAgents(workspace).map(agent => ({ id: agent.id, terminal: agent.terminal, name: agent.name, status: agent.status, runtime: agent.runtime }))];
}
