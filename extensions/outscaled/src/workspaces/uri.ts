/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { hostAuthority } from '../daemon/servers';

export interface WorkspaceLocation { host: string; slug: string; }
export const placeholder = vscode.Uri.from({ scheme: 'ws', authority: 'outscaled', path: '/' });

export function workspaceUri(host: string, slug: string, path = ''): vscode.Uri {
	validateSegment(slug);
	if (!host) throw new Error('Missing workspace host');
	const segments = path === '' ? [] : path.split('/');
	segments.forEach(validateSegment);
	return vscode.Uri.from({ scheme: 'ws', authority: hostAuthority(host), path: `/${slug}/${segments.join('/')}` });
}

function validateSegment(segment: string): void {
	if (!segment || segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) throw new Error('Invalid workspace path segment');
}

/** Uri.path is already decoded; encode each segment exactly once for HTTP. */
export function workspaceAddress(uri: vscode.Uri): WorkspaceLocation & { path: string; requestPath: string } {
	if (uri.scheme !== 'ws' || !uri.authority || uri.query || uri.fragment) throw new Error('Invalid workspace URI');
	const segments = uri.path.slice(1).split('/');
	if (segments.at(-1) === '') segments.pop();
	if (!segments.length) throw new Error('Missing workspace slug');
	segments.forEach(validateSegment);
	const [slug, ...path] = segments;
	return { host: uri.authority, slug, path: path.join('/'), requestPath: `fs/${encodeURIComponent(slug)}/${path.map(encodeURIComponent).join('/')}` };
}

export function containsUri(root: vscode.Uri, uri: vscode.Uri): boolean {
	return root.scheme === uri.scheme && root.authority === uri.authority
		&& (uri.path === root.path || uri.path.startsWith(root.path.replace(/\/$/, '') + '/'));
}

/** Workspace folder updates remove trailing separators. */
export function sameRoot(left: string | undefined, right: string | undefined): boolean {
	return left !== undefined && right !== undefined && left.replace(/\/$/, '') === right.replace(/\/$/, '');
}
