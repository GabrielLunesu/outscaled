/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Workspace } from '@outscaled/protocol';

export function registerWorkspacesView(context: vscode.ExtensionContext): void {
	// An empty tree lets VS Code show the localized viewsWelcome contribution.
	const workspaces = Workspace.array().parse([]);
	context.subscriptions.push(vscode.window.registerTreeDataProvider<Workspace>('outscaled.workspaces', {
		getChildren: () => workspaces,
		getTreeItem: workspace => new vscode.TreeItem(workspace.slug)
	}));
}
