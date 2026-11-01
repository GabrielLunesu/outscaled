/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Small API test double. URI behavior comes from VS Code's URI implementation.
export { URI as Uri } from 'vscode-uri';
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum FilePermission { Readonly = 1 }
export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }
export class Disposable {
	constructor(private readonly fn: () => void) {}
	dispose() { this.fn(); }
}
export class EventEmitter<T> {
	private readonly listeners = new Set<(value: T) => void>();
	readonly event = (listener: (value: T) => void) => { this.listeners.add(listener); return new Disposable(() => { this.listeners.delete(listener); }); };
	fire(value: T) { for (const listener of this.listeners) listener(value); }
	dispose() { this.listeners.clear(); }
}
export class FileSystemError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
	static FileNotFound(message: string) { return new FileSystemError('FileNotFound', message); }
	static FileExists(message: string) { return new FileSystemError('FileExists', message); }
	static FileIsADirectory(message: string) { return new FileSystemError('FileIsADirectory', message); }
	static FileNotADirectory(message: string) { return new FileSystemError('FileNotADirectory', message); }
	static NoPermissions(message: string) { return new FileSystemError('NoPermissions', message); }
	static Unavailable(message: string) { return new FileSystemError('Unavailable', message); }
}
