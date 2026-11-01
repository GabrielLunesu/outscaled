/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FsEntry, FsList, FsStat } from '@outscaled/protocol';
import { placeholder, workspaceAddress } from './uri';

type Request = (host: string, path: string, init?: RequestInit) => Promise<Response>;

export function fileType(entry: Pick<FsEntry, 'type' | 'symlink'>): vscode.FileType {
	return (entry.type === 'directory' ? vscode.FileType.Directory : entry.type === 'file' ? vscode.FileType.File : vscode.FileType.Unknown)
		| (entry.symlink ? vscode.FileType.SymbolicLink : 0);
}

export function daemonFileError(code: string, message: string): vscode.FileSystemError {
	switch (code) {
		case 'not_found': return vscode.FileSystemError.FileNotFound(message);
		case 'exists': return vscode.FileSystemError.FileExists(message);
		case 'is_directory': return vscode.FileSystemError.FileIsADirectory(message);
		case 'not_directory': return vscode.FileSystemError.FileNotADirectory(message);
		case 'forbidden': return vscode.FileSystemError.NoPermissions(message);
		default: return vscode.FileSystemError.Unavailable(message);
	}
}

/** Files use the same extension-owned connection as the sidebar and terminals. */
export class WorkspaceFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changes.event;
	constructor(private readonly request: Request) {}
	dispose(): void { this.changes.dispose(); }
	watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
	createDirectory(): never { throw this.unsupported('Creating directories'); }
	delete(): never { throw this.unsupported('Deleting files'); }
	rename(): never { throw this.unsupported('Renaming files'); }
	private unsupported(action: string): vscode.FileSystemError {
		return vscode.FileSystemError.NoPermissions(`${action} is not supported by wsd yet.`);
	}

	private async response(uri: vscode.Uri, query: string, init?: RequestInit): Promise<Response> {
		if (uri.toString() === placeholder.toString()) throw vscode.FileSystemError.NoPermissions('The Outscaled placeholder is read-only.');
		// Dotfiles requested relative to the empty placeholder cannot be workspace slugs.
		if (uri.authority === placeholder.authority && uri.path.startsWith('/.')) throw vscode.FileSystemError.FileNotFound(uri);
		let address: ReturnType<typeof workspaceAddress>;
		try { address = workspaceAddress(uri); }
		catch { throw vscode.FileSystemError.NoPermissions('Invalid Outscaled workspace path.'); }
		let response: Response;
		try { response = await this.request(address.host, `${address.requestPath}?${query}`, init); }
		catch { throw vscode.FileSystemError.Unavailable(`Server ${address.host} is offline or unavailable.`); }
		if (!response.ok) {
			const value = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
			throw daemonFileError(value?.error?.code ?? '', value?.error?.message ?? `wsd returned HTTP ${response.status}`);
		}
		return response;
	}

	private async read<T>(uri: vscode.Uri, operation: string, consume: (response: Response) => Promise<T>): Promise<T> {
		const response = await this.response(uri, `op=${operation}`);
		try { return await consume(response); }
		catch { throw vscode.FileSystemError.Unavailable(`Could not read the daemon response for ${uri.toString()}.`); }
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		if (uri.toString() === placeholder.toString()) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly };
		const value = await this.read(uri, 'stat', async response => FsStat.parse(await response.json()));
		return { type: fileType(value), size: value.size, mtime: value.mtimeMs, ctime: value.ctimeMs };
	}
	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		if (uri.toString() === placeholder.toString()) return [];
		return (await this.read(uri, 'list', async response => FsList.parse(await response.json()))).map(entry => [entry.name, fileType(entry)]);
	}
	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		return this.read(uri, 'read', async response => new Uint8Array(await response.arrayBuffer()));
	}
	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
		await this.response(uri, `create=${options.create}&overwrite=${options.overwrite}`, { method: 'PUT', body: Buffer.from(content) });
		this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}
}
