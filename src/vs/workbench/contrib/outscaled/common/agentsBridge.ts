/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentsLayout, isAgentsLayout, layoutTerminals } from './agentsLayout.js';

import { AgentsLaunch, AgentsPreset, isAgentsLaunch } from './agentsLaunch.js';

export const agentsBridgeVersion = 1;
export const agentsPublishCommand = '_outscaled.agents.publish';
export const agentsInspectCommand = '_outscaled.agents.inspect';
export const agentsRequestCommand = '_outscaled.agents.request';
export type AgentsMode = 'agents' | 'code';
export type AgentStatus = 'idle' | 'working' | 'needs_input' | 'crashed';
export interface AgentPane {
	id: string; name: string; runtime: 'claude-code' | 'codex' | 'shell'; status: AgentStatus;
	launch?: { executable: string; args: string[]; env: Record<string, string> };
}
export interface AgentsWorkspace {
	id: string; name: string; server: string; root: string; selected: boolean; online: boolean; branch?: string; path?: string;
	terminals: AgentPane[]; layout: AgentsLayout;
}
export interface AgentsSnapshot { version: 1; workspaces: AgentsWorkspace[]; focus?: { workspace: string; terminal: string } }
export type AgentsRequest = { version: 1; action: 'newAgents' } |
	{ version: 1; action: 'presets'; workspace: string } |
	{ version: 1; action: 'savePreset'; workspace: string; name: string; choices: AgentsLaunch } |
	{ version: 1; action: 'launch'; workspace: string; choices: AgentsLaunch; focused?: string } |
	{ version: 1; action: 'switch'; workspace: string } |
	{ version: 1; action: 'background'; workspace: string; terminal: string; focused?: string } |
	{ version: 1; action: 'resize'; workspace: string; layout: AgentsLayout } |
	{ version: 1; action: 'focus'; workspace: string; terminal: string };
export interface AgentsReceipt {
	version: 1; ok: boolean; error?: string; presets?: AgentsPreset[];
	panes?: { workspace: string; terminal: string; processId?: number; visible: boolean }[];
}

function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 32768; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function pane(value: unknown): value is AgentPane {
	if (!record(value) || !text(value.id) || !text(value.name) || (typeof value.runtime !== 'string' || !['claude-code', 'codex', 'shell'].includes(value.runtime)) ||
		(typeof value.status !== 'string' || !['idle', 'working', 'needs_input', 'crashed'].includes(value.status))) { return false; }
	const launch = value.launch;
	return launch === undefined || (record(launch) && text(launch.executable) && Array.isArray(launch.args) &&
		launch.args.length <= 32 && launch.args.every(arg => typeof arg === 'string') && record(launch.env) &&
		Object.entries(launch.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string'));
}

/** The command transport crosses the extension host boundary; reject malformed whole messages. */
export function isAgentsSnapshot(value: unknown): value is AgentsSnapshot {
	if (!record(value) || value.version !== agentsBridgeVersion || !Array.isArray(value.workspaces) || value.workspaces.length > 1000) { return false; }
	const ids = new Set<string>();
	let selected = 0;
	for (const workspace of value.workspaces) {
		if (!record(workspace) || !text(workspace.id) || ids.has(workspace.id) || !text(workspace.name) || !text(workspace.server) ||
			!text(workspace.root) || !/^(file|ws):/.test(workspace.root) || typeof workspace.selected !== 'boolean' || typeof workspace.online !== 'boolean' ||
			(workspace.branch !== undefined && !text(workspace.branch)) || (workspace.path !== undefined && !text(workspace.path)) || !Array.isArray(workspace.terminals) || workspace.terminals.length > 4096 ||
			!workspace.terminals.every(pane) || !isAgentsLayout(workspace.layout)) { return false; }
		ids.add(workspace.id);
		if (workspace.selected) { selected++; }
		const terminals = new Set(workspace.terminals.map(terminal => terminal.id));
		if (terminals.size !== workspace.terminals.length || !layoutTerminals(workspace.layout).every(id => terminals.has(id))) { return false; }
	}
	if (selected > 1) { return false; }
	if (value.focus !== undefined) {
		if (!record(value.focus) || !text(value.focus.workspace) || !text(value.focus.terminal)) { return false; }
		const focus = value.focus;
		if (!value.workspaces.some(workspace => workspace.id === focus.workspace && workspace.terminals.some((terminal: AgentPane) => terminal.id === focus.terminal))) { return false; }
	}
	return true;
}

export function isAgentsRequest(value: unknown): value is AgentsRequest {
	return record(value) && value.version === agentsBridgeVersion && (value.action === 'newAgents' ||
		(value.action === 'presets' && text(value.workspace)) ||
		(value.action === 'savePreset' && text(value.workspace) && text(value.name) && value.name.length <= 128 && isAgentsLaunch(value.choices)) ||
		(value.action === 'launch' && text(value.workspace) && isAgentsLaunch(value.choices) && (value.focused === undefined || text(value.focused))) ||
		(value.action === 'resize' && text(value.workspace) && isAgentsLayout(value.layout)) ||
		(value.action === 'background' && text(value.workspace) && text(value.terminal) && (value.focused === undefined || text(value.focused))) ||
		(value.action === 'switch' && text(value.workspace)) || (value.action === 'focus' && text(value.workspace) && text(value.terminal)));
}

export function isAgentsReceipt(value: unknown): value is AgentsReceipt {
	return record(value) && value.version === agentsBridgeVersion && typeof value.ok === 'boolean' &&
		(value.presets === undefined || (Array.isArray(value.presets) && value.presets.length <= 1024 && value.presets.every(preset => record(preset) && text(preset.name) && preset.name.length <= 128 && isAgentsLaunch(preset.choices)))) &&
		(value.error === undefined || typeof value.error === 'string') && (value.panes === undefined || (Array.isArray(value.panes) && value.panes.every(pane =>
			record(pane) && text(pane.workspace) && text(pane.terminal) && typeof pane.visible === 'boolean' &&
			(pane.processId === undefined || (typeof pane.processId === 'number' && Number.isSafeInteger(pane.processId) && pane.processId > 0)))));
}
