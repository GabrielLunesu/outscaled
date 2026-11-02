/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';
import { CreateScheduleRequest, Run, ScheduleSummary, UpdateScheduleRequest } from '@outscaled/protocol';
import { AgentsLaunch, canLaunchAgents, launchNames } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLaunch.js';
import type { AgentsRequest } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsBridge.js';
import type { DaemonService } from '../daemon/service';
import type { WorkspaceLocation } from '../workspaces/uri';

type Requester = Pick<DaemonService, 'request'>;
async function request(service: Requester, workspace: WorkspaceLocation, suffix: string, method: string, body?: object): Promise<Response> {
	const response = await service.request(workspace.host, `workspaces/${encodeURIComponent(workspace.slug)}/schedules${suffix}`, {
		method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
	});
	if (!response.ok) { throw new Error(l10n.t('Schedule request failed (HTTP {0})', response.status)); }
	return response;
}
export async function listSchedules(service: Requester, workspace: WorkspaceLocation): Promise<ScheduleSummary[]> {
	return ScheduleSummary.array().parse(await (await request(service, workspace, '', 'GET')).json());
}
/** Allocate against both namespaces; the daemon also rejects concurrent name collisions. */
export async function createSchedules(service: Requester, workspace: WorkspaceLocation, choices: AgentsLaunch, names: string[]): Promise<void> {
	if (choices.run !== 'scheduled' || !canLaunchAgents(choices)) { throw new Error(l10n.t('Scheduled agents require a prompt and Claude or Codex panes')); }
	const schedules = await listSchedules(service, workspace);
	const allocated = launchNames(choices.agents, [...names, ...schedules.map(schedule => schedule.name)]);
	for (const [index, name] of allocated.entries()) {
		const body = CreateScheduleRequest.parse({ name, runtime: choices.agents[index] === 'claude' ? 'claude-code' : 'codex', every: choices.interval, prompt: choices.prompt });
		ScheduleSummary.parse(await (await request(service, workspace, '', 'POST', body)).json());
	}
}
export async function changeSchedule(service: Requester, workspace: WorkspaceLocation, change: Extract<AgentsRequest, { action: 'schedule' | 'editSchedule' }>): Promise<void> {
	const schedule = (await listSchedules(service, workspace)).find(schedule => schedule.name === change.name);
	if (!schedule) { throw new Error(l10n.t('Schedule is unavailable')); }
	if ((change.action === 'editSchedule' || change.operation === 'delete') && (schedule.source !== 'app' || schedule.readOnly)) { throw new Error(l10n.t('Edit this schedule in workspace.toml')); }
	if (change.action === 'schedule' && change.operation === 'run' && schedule.lastRun?.status === 'running') { throw new Error(l10n.t('A run is already in progress')); }
	const path = `/${encodeURIComponent(change.name)}`;
	if (change.action === 'editSchedule') {
		const body = UpdateScheduleRequest.parse({ every: change.every, prompt: change.prompt });
		ScheduleSummary.parse(await (await request(service, workspace, path, 'PATCH', body)).json());
	} else if (change.operation === 'delete') { await request(service, workspace, path, 'DELETE'); }
	else {
		const response = await request(service, workspace, `${path}/${change.operation}`, 'POST');
		if (change.operation === 'run') { Run.parse(await response.json()); }
		else { ScheduleSummary.parse(await response.json()); }
	}
}
