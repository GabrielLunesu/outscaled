/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { WorkspaceLocation } from './uri';

export interface SelectedWorkspace extends WorkspaceLocation { root: string; }
export interface WorkspaceSelectionChange { previous: SelectedWorkspace | undefined; current: SelectedWorkspace; waitUntil(work: PromiseLike<void>): void; }

/** Shared with the terminal grid: one event after each committed root switch. */
export class WorkspaceSelection implements vscode.Disposable {
	private readonly preparing = new vscode.EventEmitter<WorkspaceSelectionChange>();
	readonly onWillChangeSelectedWorkspace = this.preparing.event;
	private readonly changes = new vscode.EventEmitter<WorkspaceSelectionChange>();
	readonly onDidChangeSelectedWorkspace = this.changes.event;
	constructor(public current: SelectedWorkspace | undefined) {}
	prepare(current: SelectedWorkspace): Promise<void> { return this.fire(this.preparing, current, this.current); }
	select(current: SelectedWorkspace): Promise<void> {
		const previous = this.current;
		this.current = current;
		return this.fire(this.changes, current, previous);
	}
	private async fire(emitter: vscode.EventEmitter<WorkspaceSelectionChange>, current: SelectedWorkspace, previous: SelectedWorkspace | undefined): Promise<void> {
		const work: PromiseLike<void>[] = [];
		emitter.fire({ previous, current, waitUntil: promise => { work.push(promise); } });
		await Promise.all(work);
	}
	dispose(): void { this.preparing.dispose(); this.changes.dispose(); }
}
