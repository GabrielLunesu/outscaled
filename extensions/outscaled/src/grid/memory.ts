/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceLocation } from '../workspaces/uri';
import { workspaceKey } from '../workspaces/editorMemory';
import type { EditorGroupLayout, GridPane } from './presets';

export const gridMemoryKey = 'outscaled.workspaceGrids';
export interface RememberedPane extends GridPane { terminalId: string; }
export interface RememberedGrid { layout: EditorGroupLayout; preset?: string; panes: RememberedPane[]; }
/** Durable desired grids, independent of disposable VS Code attach clients.
 * Closing a client retains its assignment for the later grid restoration feature.
 */
export class GridMemory {
	constructor(private readonly entries: Record<string, RememberedGrid> = {}) {}
	remember(workspace: WorkspaceLocation, grid: RememberedGrid): void { this.entries[workspaceKey(workspace)] = structuredClone(grid); }
	recall(workspace: WorkspaceLocation): RememberedGrid | undefined {
		const grid = this.entries[workspaceKey(workspace)];
		return grid && structuredClone(grid);
	}
	serialize(): Record<string, RememberedGrid> { return structuredClone(this.entries); }
}
