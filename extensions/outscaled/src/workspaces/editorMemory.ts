/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SelectedWorkspace } from './selection';

export interface RememberedEditor {
	uri: string;
	original?: string;
	viewColumn: number;
	active: boolean;
}
export function workspaceKey(workspace: Pick<SelectedWorkspace, 'host' | 'slug'>): string {
	return JSON.stringify([workspace.host, workspace.slug]);
}

/** Snapshots include dirty tabs, but only clean tabs are eligible to close. */
export class EditorMemory {
	constructor(private readonly entries: Record<string, RememberedEditor[]> = {}) {}
	remember(workspace: SelectedWorkspace, editors: readonly RememberedEditor[]): void {
		this.entries[workspaceKey(workspace)] = editors.map(editor => ({ ...editor }));
	}
	recall(workspace: SelectedWorkspace): RememberedEditor[] {
		return (this.entries[workspaceKey(workspace)] ?? []).map(editor => ({ ...editor }));
	}
	serialize(): Record<string, RememberedEditor[]> { return structuredClone(this.entries); }
}
