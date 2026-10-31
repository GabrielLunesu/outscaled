/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerWorkspacesView } from './workspaces/view';

export function activate(context: vscode.ExtensionContext): void {
	registerWorkspacesView(context);
}
