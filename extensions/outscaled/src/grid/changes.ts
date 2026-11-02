/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentChangedFile, AgentChangeEditor, AgentChanges, AgentsWorkspace } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsBridge.js';

/** Subset of vscode.git's public v1 API; no dependency on its proposed API types. */
export interface ChangesRepository {
	rootUri: vscode.Uri;
	state: { HEAD?: { name?: string }; indexChanges: readonly { uri: vscode.Uri; renameUri?: vscode.Uri }[] };
	status(): Promise<void>;
	add(paths: string[]): Promise<void>;
	commit(message: string, options: { all: false; postCommitCommand: null }): Promise<void>;
}
export interface ChangesGitAPI {
	repositories: readonly ChangesRepository[];
	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
	getRepository(uri: vscode.Uri): ChangesRepository | null;
	openRepository(uri: vscode.Uri): Promise<ChangesRepository | null>;
}
export interface ChangesGitExtension { enabled: boolean; getAPI(version: 1): ChangesGitAPI }

/** Resource construction stays beside Git's API, including rename bases and empty sides. */
export function changeEditor(api: Pick<ChangesGitAPI, 'toGitUri'>, workspace: AgentsWorkspace, file: AgentChangedFile): AgentChangeEditor {
	const root = vscode.Uri.parse(workspace.root);
	const modified = vscode.Uri.joinPath(root, file.path);
	if (root.scheme === 'ws') { return { modified: modified.toString(), label: file.path }; }
	const empty = (path: string) => vscode.Uri.from({ scheme: 'outscaled-empty', path: '/' + path }).toString();
	return {
		original: file.status === 'added' || file.status === 'untracked' ? empty(file.path) : api.toGitUri(vscode.Uri.joinPath(root, file.originalPath ?? file.path), 'HEAD').toString(),
		modified: file.status === 'deleted' ? empty(file.path) : modified.toString(),
		label: vscode.l10n.t('{0} (Changes)', file.path)
	};
}

/** Stage exactly the visible set; refuse unrelated staged paths in a containing repository. */
export async function commitChanges(repository: ChangesRepository, root: vscode.Uri, changes: AgentChanges, paths: readonly string[], message: string): Promise<void> {
	if (root.scheme !== 'file') { throw new Error(vscode.l10n.t('Diffs and Commit for VPS workspaces come later.')); }
	if (!message.trim() || message.length > 32768 || message.includes('\0')) { throw new Error(vscode.l10n.t('Enter a commit message.')); }
	if (!paths.length || new Set(paths).size !== paths.length || changes.files.length !== paths.length || changes.files.some(file => !paths.includes(file.path))) {
		throw new Error(vscode.l10n.t('The changed files have changed. Review Changes and try again.'));
	}
	const stagePaths = new Set(changes.files.flatMap(file => [file.path, ...(file.originalPath ? [file.originalPath] : [])]).map(path => vscode.Uri.joinPath(root, path).fsPath));
	const checkIndex = () => {
		if (repository.state.indexChanges.some(change => !stagePaths.has(change.uri.fsPath) || (change.renameUri && !stagePaths.has(change.renameUri.fsPath)))) {
			throw new Error(vscode.l10n.t('Other files are already staged in this repository. Commit or unstage them in Source Control first.'));
		}
	};
	await repository.status(); checkIndex();
	await repository.add([...stagePaths]);
	await repository.status(); checkIndex();
	if (!repository.state.indexChanges.length) { throw new Error(vscode.l10n.t('No changes to commit.')); }
	await repository.commit(message.trim(), { all: false, postCommitCommand: null });
}

/** Git API errors carry stderr separately from their short Error message. */
export function changesErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const details = typeof error === 'object' && error !== null ? error as { readonly stderr?: unknown } : undefined;
	const stderr = typeof details?.stderr === 'string' ? details.stderr.trim() : '';
	return stderr && !message.includes(stderr) ? [message, stderr].join('\n') : message;
}
