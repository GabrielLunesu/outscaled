/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentsLayout, isAgentsLayout, layoutTerminals, reconcileLayout, removePane, sameLayoutStructure } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLayout.js';
import { l10n } from 'vscode';
import type { AgentsRequest } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsBridge.js';
import type { WorkspaceLocation } from '../workspaces/uri';
import { workspaceKey } from '../workspaces/identity';

interface GridEntry { layout: AgentsLayout; known: string[] }
export const gridMemoryKey = 'outscaled.agentsGrids.v1';
/** Only layout membership is durable. Attach clients belong to the core workspace owner. */
export class GridMemory {
	private readonly entries: Record<string, GridEntry> = {};
	constructor(value?: Record<string, GridEntry>) {
		for (const [key, entry] of Object.entries(value ?? {})) {if (entry && isAgentsLayout(entry.layout) && Array.isArray(entry.known) && entry.known.every(id => typeof id === 'string')) {this.entries[key] = structuredClone(entry);}}
	}
	remember(workspace: WorkspaceLocation, layout: AgentsLayout, known?: string[]): void { this.entries[workspaceKey(workspace)] = { layout: structuredClone(layout), known: known ?? this.entries[workspaceKey(workspace)]?.known ?? [] }; }
	recall(workspace: WorkspaceLocation): AgentsLayout | undefined { const tree = this.entries[workspaceKey(workspace)]?.layout; return tree && structuredClone(tree); }
	reconcile(workspace: WorkspaceLocation, ids: ReadonlySet<string>): AgentsLayout | undefined {
		const tree = this.recall(workspace); return tree && reconcileLayout(tree, ids);
	}
	known(workspace: WorkspaceLocation): readonly string[] { return this.entries[workspaceKey(workspace)]?.known ?? []; }
	serialize(): Record<string, GridEntry> { return structuredClone(this.entries); }
}

/** Apply only grid edits: neither request stops or recreates a daemon terminal. */
export function applyGridRequest(memory: GridMemory, workspace: WorkspaceLocation, tree: AgentsLayout,
	request: Extract<AgentsRequest, { action: 'background' | 'resize' }>, known: string[]): string | undefined {
	if (request.action === 'resize') {
		if (!sameLayoutStructure(tree, request.layout)) { throw new Error(l10n.t('The grid changed while resizing. Try again.')); }
		memory.remember(workspace, request.layout, known);
		return undefined;
	}
	const before = layoutTerminals(tree);
	const index = before.indexOf(request.terminal);
	if (index < 0) { throw new Error(l10n.t('This terminal is not in the grid')); }
	const layout = removePane(tree, request.terminal);
	memory.remember(workspace, layout, known);
	const remaining = layoutTerminals(layout);
	return request.focused && remaining.includes(request.focused) ? request.focused : remaining[Math.min(index, remaining.length - 1)];
}
