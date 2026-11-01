/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

async function executable(path: string): Promise<boolean> {
	try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}
/** Resolve argv[0] without invoking a shell. An explicit setting must be valid. */
export async function findWsPath(setting?: string, env: NodeJS.ProcessEnv = process.env, home = homedir(),
	canExecute: (path: string) => Promise<boolean> = executable): Promise<string> {
	const expand = (path: string) => path.startsWith('~/') ? join(home, path.slice(2)) : path;
	const directories = [...(env.PATH ?? '').split(delimiter).filter(path => isAbsolute(path)),
		join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
	const value = setting?.trim();
	const candidates = value && (value.includes('/') || value.startsWith('~')) ? [expand(value)]
		: directories.map(directory => join(directory, value || 'ws'));
	for (const path of candidates) if (isAbsolute(path) && await canExecute(path)) return path;
	throw new Error(value ? 'outscaled.wsPath is not an executable. Set it to the ws binary.' : 'Could not find ws. Set outscaled.wsPath to the ws binary.');
}

export function attachArgs(host: string, workspace: string, name: string): string[] {
	return ['attach', workspace, name, ...(host === 'local' ? [] : ['--on', host])];
}
export function attachEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return Object.fromEntries(['WSD_PORT', 'WSD_TMUX_SOCKET'].flatMap(key => env[key] === undefined ? [] : [[key, env[key]!]]));
}
