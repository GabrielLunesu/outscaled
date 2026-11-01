/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerWorkspacesView } from './workspaces/view';
import { DaemonService } from './daemon/service';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Outscaled');
	const daemons = new DaemonService(message => output.appendLine(message));
	context.subscriptions.push(output, daemons);
	registerWorkspacesView(context, daemons);
}
