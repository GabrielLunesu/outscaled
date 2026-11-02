/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DaemonService } from '../daemon/service';
import { SelectedWorkspace, WorkspaceSelection } from './selection';
import { placeholder, sameRoot, WorkspaceLocation, workspaceUri } from './uri';

const selectionKey = 'outscaled.selectedWorkspace';

function dedicatedWindow(): boolean {
	return !!vscode.workspace.workspaceFile && vscode.workspace.workspaceFolders?.[0]?.uri.toString() === placeholder.toString();
}

export function registerWorkspaceSwitching(context: vscode.ExtensionContext, service: DaemonService, log: (message: string) => void): WorkspaceSelection {
	const saved = context.globalState.get<SelectedWorkspace>(selectionKey);
	const root = vscode.workspace.workspaceFolders?.[1]?.uri.toString();
	const selection = new WorkspaceSelection(dedicatedWindow() && sameRoot(saved?.root, root) ? saved : undefined);
	let queue = Promise.resolve();

	const switchTo = async (target?: WorkspaceLocation) => {
		log(`Workspace switch requested: ${JSON.stringify(target)}`);
		if (!target) {
			const items = service.servers.flatMap(server => server.workspaces.map(workspace => ({
				label: workspace.slug, description: server.host, target: { host: server.host, slug: workspace.slug }
			})));
			target = (await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Switch Outscaled workspace') }))?.target;
		}
		if (!target) {return;}
		const server = service.servers.find(server => server.host === target.host);
		const workspace = server?.workspaces.find(workspace => workspace.slug === target.slug);
		if (!server?.online || !workspace) {throw new Error('The workspace is unavailable. Check its server connection.');}
		const uri = target.host === 'local' ? vscode.Uri.file(workspace.path) : workspaceUri(target.host, target.slug);
		const next: SelectedWorkspace = { ...target, root: uri.toString() };

		if (!dedicatedWindow()) {
			const directory = process.env.OUTSCALED_CONFIG_DIR ?? join(homedir(), '.config/outscaled');
			await mkdir(directory, { recursive: true });
			const path = join(directory, 'outscaled.code-workspace');
			// Preserve user settings in our generated workspace on subsequent entries.
			let document: Record<string, unknown> = {};
			try { document = JSON.parse(await readFile(path, 'utf8')); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;} }
			document.folders = [{ uri: placeholder.toString(), name: 'Outscaled' }, { uri: next.root, name: next.slug }];
			await writeFile(path, JSON.stringify(document, null, '\t') + '\n');
			await context.globalState.update(selectionKey, next);
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), { forceReuseWindow: true });
			return;
		}
		if (sameRoot(selection.current?.root, next.root) && selection.current?.host === next.host && selection.current.slug === next.slug) {return;}
		const previous = selection.current;
		await selection.prepare(next);
		log(`Switching root: ${previous?.root} -> ${next.root}`);
		if (!sameRoot(rootUri(), next.root)) {
			await new Promise<void>((resolve, reject) => {
				const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
					if (sameRoot(rootUri(), next.root)) { clearTimeout(timer); subscription.dispose(); resolve(); }
				});
				const timer = setTimeout(() => { subscription.dispose(); reject(new Error('Workspace folder switch timed out.')); }, 10000);
				if (!vscode.workspace.updateWorkspaceFolders(1, (vscode.workspace.workspaceFolders?.length ?? 1) - 1, { uri, name: next.slug })) {
					clearTimeout(timer); subscription.dispose(); reject(new Error('Could not update the Outscaled workspace folders.'));
				}
			});
		}
		await context.globalState.update(selectionKey, next);
		log(`Selected root: ${next.root}`);
		await selection.select(next);

	};
	context.subscriptions.push(selection, vscode.commands.registerCommand('outscaled.switchWorkspace', (target?: WorkspaceLocation) => {
		queue = queue.then(async () => {
			await switchTo(target);
		}).catch(error => { void vscode.window.showErrorMessage(`Outscaled: ${String(error)}`); });
		return queue;
	}));
	return selection;
}

function rootUri(): string | undefined { return vscode.workspace.workspaceFolders?.[1]?.uri.toString(); }
