/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerWorkspacesView } from './workspaces/view';
import { DaemonService } from './daemon/service';
import { WorkspaceFileSystem } from './workspaces/fileSystem';
import { registerWorkspaceSwitching } from './workspaces/switching';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Outscaled');
	const daemons = new DaemonService(message => output.appendLine(message));
	context.subscriptions.push(output, daemons);
	const files = new WorkspaceFileSystem((host, path, init) => daemons.request(host, path, init));
	context.subscriptions.push(files, vscode.workspace.registerFileSystemProvider('ws', files, { isCaseSensitive: true }));
	const selection = registerWorkspaceSwitching(context, daemons, message => output.appendLine(message));
	registerWorkspacesView(context, daemons, selection);
}
