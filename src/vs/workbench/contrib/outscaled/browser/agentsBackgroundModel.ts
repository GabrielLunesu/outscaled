/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { AgentPane, AgentSchedule, AgentsWorkspace } from '../common/agentsBridge.js';
import { layoutTerminals } from '../common/agentsLayout.js';
import { agentRequestText, canAnswerAgent } from './agentsWaitingModel.js';
import { agentStatusLabel } from './agentsSidebarModel.js';

export function agentRuntimeLabel(runtime: AgentPane['runtime'] | 'script'): string {
	return { 'claude-code': localize('background.claude', "Claude"), codex: localize('background.codex', "Codex"), shell: localize('background.shell', "Shell"), script: localize('background.script', "Script") }[runtime];
}
export function runStatusLabel(status: NonNullable<AgentSchedule['lastRun']>['status']): string {
	return { running: localize('background.running', "Running"), succeeded: localize('background.succeeded', "Succeeded"), failed: localize('background.failed', "Failed"), interrupted: localize('background.interrupted', "Interrupted") }[status];
}
export function scheduleTime(time: string | null): string { return time ? new Date(time).toLocaleString() : localize('background.none', "—"); }

/** Schedule and terminal identities coalesce even after the first run or a reload. */
export function backgroundAgents(workspace: AgentsWorkspace) {
	const grid = new Set(layoutTerminals(workspace.layout));
	const schedules = workspace.schedules ?? [];
	const models = workspace.terminals.filter(terminal => !grid.has(terminal.id) && !schedules.some(schedule => schedule.name === terminal.name))
		.map(terminal => backgroundAgent(workspace, terminal));
	for (const schedule of schedules) {
		const terminal = workspace.terminals.find(terminal => terminal.name === schedule.name);
		if (!terminal || !grid.has(terminal.id)) { models.push(backgroundAgent(workspace, terminal, schedule)); }
	}
	return models;
}
function backgroundAgent(workspace: AgentsWorkspace, terminal?: AgentPane, schedule?: AgentSchedule) {
	const name = schedule?.name ?? terminal!.name;
	const status = terminal?.status ?? (schedule?.lastRun?.status === 'running' ? 'working' : schedule?.lastRun?.status === 'failed' ? 'crashed' : 'idle');
	const latestLine = terminal?.latestLine ?? schedule?.lastRun?.result.split(/\r?\n/)[0] ?? '';
	const runtime = agentRuntimeLabel(schedule?.runtime ?? terminal!.runtime);
	const next = schedule ? schedule.paused ? localize('background.paused', "Paused") : localize('background.next', "Next: {0}", scheduleTime(schedule.nextRunAt)) : '';
	return { id: schedule ? `schedule:${name}` : `terminal:${terminal!.id}`, name, terminal: terminal?.id, runtime, status, latestLine, schedule, next, request: terminal ? agentRequestText(terminal) : '', canAnswer: !!terminal && canAnswerAgent(terminal),
		label: localize('background.label', "{0}, {1}, {2}. {3} {4}", name, runtime, agentStatusLabel(status), latestLine, next),
		offline: !workspace.online,
		openReason: !workspace.online ? localize('background.offline', "This workspace is offline.") : schedule?.runtime === 'script' ? localize('background.scriptTerminal', "Scripts run without a terminal.") : !terminal ? localize('background.noTerminal', "A terminal is available after the first run.") : '',
		runReason: !workspace.online ? localize('background.offline', "This workspace is offline.") : schedule?.lastRun?.status === 'running' ? localize('background.activeRun', "A run is already in progress.") : '',
		editable: schedule?.source === 'app' && !schedule.readOnly,
		editReason: schedule?.source === 'workspace' || schedule?.readOnly ? localize('background.workspaceSchedule', "Edit this schedule in .ws/workspace.toml.") : '' };
}
export type BackgroundAgent = ReturnType<typeof backgroundAgent>;
