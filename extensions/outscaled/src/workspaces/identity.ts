/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceLocation } from './uri';

/** Workspace identity includes the server, even when slugs match. */
export function workspaceKey(workspace: WorkspaceLocation): string {
	return JSON.stringify([workspace.host, workspace.slug]);
}
