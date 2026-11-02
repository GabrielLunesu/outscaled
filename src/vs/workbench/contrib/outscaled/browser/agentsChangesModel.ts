/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { AgentChangedFile, AgentsWorkspace } from '../common/agentsBridge.js';

export function changeStatusLabel(status: AgentChangedFile['status']): string {
	switch (status) {
		case 'modified': return localize('changes.modified', "Modified");
		case 'added': return localize('changes.added', "Added");
		case 'deleted': return localize('changes.deleted', "Deleted");
		case 'renamed': return localize('changes.renamed', "Renamed");
		case 'untracked': return localize('changes.untracked', "Untracked");
	}
}

/** Keep deterministic newest-first ordering even across older bridge producers. */
export function changesModel(workspace: AgentsWorkspace | undefined) {
	const remote = workspace?.root.startsWith('ws:') ?? false;
	const files = (workspace?.changes?.files ?? []).map(file => ({ ...file, agents: [...file.agents].sort((a, b) => b.time.localeCompare(a.time)) }))
		.sort((a, b) => (b.agents[0]?.time ?? '').localeCompare(a.agents[0]?.time ?? '') || a.path.localeCompare(b.path));
	return { files, remote, unavailable: workspace?.changes?.attributionAvailable === false,
		note: remote ? localize('changes.vps', "Diffs and Commit for VPS workspaces come later. Open in Editor opens the file.") : '',
		error: workspace?.changesError ?? '',
		unavailableLabel: workspace?.changes?.attributionAvailable === false ? localize('changes.unavailable', "Agent attribution is unavailable for this workspace.") : '' };
}

export const inferredChangeExplanation = localize('changes.inferredExplanation', "Approximate: Codex attribution compares files at the start and end of its turn. Concurrent agents' edits may be included, and edits before the turn was observed may be missed.");

export function commitDisabledReason(workspace: AgentsWorkspace | undefined, message: string, busy: boolean): string {
	if (busy) { return localize('changes.committing', "Committing…"); }
	if (workspace?.root.startsWith('ws:')) { return localize('changes.vpsCommit', "Commit for VPS workspaces comes later."); }
	if (!workspace?.online) { return localize('changes.offline', "The workspace is offline."); }
	if (workspace.changesError) { return workspace.changesError; }
	if (!workspace.changes?.files.length) { return localize('changes.nothing', "No changes to commit."); }
	if (!message.trim()) { return localize('changes.messageRequired', "Enter a commit message."); }
	return '';
}
