/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { WorkspaceLocation } from './uri';

export interface SelectedWorkspace extends WorkspaceLocation { root: string; }
export interface WorkspaceSelectionChange { previous: SelectedWorkspace | undefined; current: SelectedWorkspace; }

/** Shared with the terminal grid: one event after each committed root switch. */
export class WorkspaceSelection implements vscode.Disposable {
	private readonly changes = new vscode.EventEmitter<WorkspaceSelectionChange>();
	readonly onDidChangeSelectedWorkspace = this.changes.event;
	constructor(public current: SelectedWorkspace | undefined) {}
	select(current: SelectedWorkspace): void {
		const previous = this.current;
		this.current = current;
		this.changes.fire({ previous, current });
	}
	dispose(): void { this.changes.dispose(); }
}
