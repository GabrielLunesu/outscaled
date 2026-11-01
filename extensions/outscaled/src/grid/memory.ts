/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal } from '@outscaled/protocol';
import type { WorkspaceLocation } from '../workspaces/uri';
import { workspaceKey } from '../workspaces/editorMemory';
import type { EditorGroupLayout, GridPane } from './presets';

export const gridMemoryKey = 'outscaled.workspaceGrids';
export interface RememberedPane extends GridPane { terminalId: string; }
export interface RememberedGrid { layout: EditorGroupLayout; preset?: string; panes: RememberedPane[]; }
/** Capture only owned terminal tabs that still exist, in current group/tab order.
 * The controller binds tabs when attaching; text editors and unrelated terminals
 * never become remembered panes, even if they share a terminal's label.
 */
export function recordGrid<T>(layout: EditorGroupLayout, groups: readonly { viewColumn: number; tabs: readonly T[] }[],
	panes: readonly { tab?: T; pane: RememberedPane }[], preset?: string): RememberedGrid {
	const owned = new Map<T, RememberedPane>(panes.filter(entry => entry.tab !== undefined).map(entry => [entry.tab!, entry.pane]));
	return { layout: structuredClone(layout), preset, panes: groups.flatMap(group => group.tabs.flatMap(tab => {
		const pane = owned.get(tab);
		return pane ? [{ ...pane, viewColumn: group.viewColumn }] : [];
	})) };
}
/** Restore by immutable daemon identity, never by a reused name or a new launch. */
export function restorePlan(grid: RememberedGrid, terminals: readonly Terminal[]): RememberedGrid {
	return { ...structuredClone(grid), panes: grid.panes.filter(pane => terminals.some(terminal =>
		terminal.id === pane.terminalId && terminal.name === pane.name && terminal.state === 'running')).map(pane => ({ ...pane })) };
}
/** Durable actual grids, independent of disposable VS Code attach clients. */
export class GridMemory {
	constructor(private readonly entries: Record<string, RememberedGrid> = {}) {}
	remember(workspace: WorkspaceLocation, grid: RememberedGrid): void { this.entries[workspaceKey(workspace)] = structuredClone(grid); }
	recall(workspace: WorkspaceLocation): RememberedGrid | undefined {
		const grid = this.entries[workspaceKey(workspace)];
		return grid && structuredClone(grid);
	}
	serialize(): Record<string, RememberedGrid> { return structuredClone(this.entries); }
}
