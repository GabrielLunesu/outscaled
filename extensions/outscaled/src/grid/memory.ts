/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentsLayout, isAgentsLayout, reconcileLayout } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLayout.js';
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
