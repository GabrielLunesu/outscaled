/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { containsUri, placeholder, sameRoot, workspaceAddress, workspaceUri } from '../src/workspaces/uri';
import { daemonFileError, fileType, WorkspaceFileSystem } from '../src/workspaces/fileSystem';
import { EditorMemory } from '../src/workspaces/editorMemory';
import { WorkspaceSelection } from '../src/workspaces/selection';
import { hostAuthority } from '../src/daemon/servers';

test('workspace URIs round-trip SSH targets and decoded path segments exactly once', () => {
	for (const host of ['example-alias', 'user@host', '[::1]', 'user@[::1]', 'MixedCase']) {
		const uri = vscode.Uri.parse(workspaceUri(host, 'demo', 'sub dir/100% #?é.txt').toString());
		assert.deepEqual(workspaceAddress(uri), { host: hostAuthority(host), slug: 'demo', path: 'sub dir/100% #?é.txt',
			requestPath: 'fs/demo/sub%20dir/100%25%20%23%3F%C3%A9.txt' });
	}
	assert.equal(workspaceAddress(workspaceUri('host', 'demo')).requestPath, 'fs/demo/');
	assert.equal(workspaceAddress(vscode.Uri.parse('ws://host/demo')).path, '');
	assert.ok(sameRoot('ws://host/demo/', 'ws://host/demo'));
	assert.ok(!sameRoot(undefined, undefined));
	for (const path of ['../secret', 'foo//bar', 'foo/./bar', 'foo\\bar', 'nul\0']) assert.throws(() => workspaceUri('host', 'demo', path));
	for (const uri of ['file:///demo', 'ws://host/', 'ws://host/demo/a?query', 'ws://host/demo/a#fragment', 'ws://host/demo/%2e%2e/secret']) {
		assert.throws(() => workspaceAddress(vscode.Uri.parse(uri)));
	}
});

test('root membership respects host, scheme and path boundaries', () => {
	const root = vscode.Uri.file('/test/demo');
	assert.ok(containsUri(root, vscode.Uri.file('/test/demo/a.txt')));
	assert.ok(!containsUri(root, vscode.Uri.file('/test/demo-other/a.txt')));
	assert.ok(!containsUri(workspaceUri('a', 'demo'), workspaceUri('b', 'demo', 'file')));
	assert.ok(!containsUri(root, workspaceUri('a', 'demo', 'file')));
});

test('provider builds stat/list/read/write requests, preserves bytes and flags', async () => {
	const calls: { host: string; path: string; init?: RequestInit }[] = [];
	const responses = [Response.json({ type: 'file', symlink: true, size: 3, mtimeMs: 12, ctimeMs: 4 }),
		Response.json([{ name: 'dangling', type: 'unknown', symlink: true }, { name: 'sub', type: 'directory', symlink: false }]),
		new Response(new Uint8Array([0, 128, 255])), new Response(null, { status: 204 })];
	const provider = new WorkspaceFileSystem(async (host, path, init) => { calls.push({ host, path, init }); return responses.shift()!; });
	const uri = workspaceUri('user@host', 'demo', 'sub dir/a%.txt');
	assert.deepEqual(await provider.stat(uri), { type: 65, size: 3, mtime: 12, ctime: 4 });
	assert.deepEqual(await provider.readDirectory(workspaceUri('user@host', 'demo')), [['dangling', 64], ['sub', 2]]);
	assert.deepEqual(await provider.readFile(uri), new Uint8Array([0, 128, 255]));
	let changed: vscode.FileChangeEvent[] = [];
	provider.onDidChangeFile(events => { changed = events; });
	await provider.writeFile(uri, new Uint8Array([0, 255]), { create: false, overwrite: true });
	assert.deepEqual(calls.map(call => [call.host, call.path]), [
		['user@host', 'fs/demo/sub%20dir/a%25.txt?op=stat'], ['user@host', 'fs/demo/?op=list'],
		['user@host', 'fs/demo/sub%20dir/a%25.txt?op=read'], ['user@host', 'fs/demo/sub%20dir/a%25.txt?create=false&overwrite=true']]);
	assert.equal(calls[3].init?.method, 'PUT');
	assert.deepEqual([...calls[3].init!.body as Uint8Array], [0, 255]);
	assert.equal(changed[0].uri.toString(), uri.toString());
	assert.equal(fileType({ type: 'unknown', symlink: false }), vscode.FileType.Unknown);
	provider.dispose();
});

test('provider maps daemon errors, network failure and offline servers', async () => {
	for (const [code, expected] of Object.entries({ not_found: 'FileNotFound', exists: 'FileExists', is_directory: 'FileIsADirectory',
		not_directory: 'FileNotADirectory', forbidden: 'NoPermissions', invalid_request: 'Unavailable', other: 'Unavailable' })) {
		assert.equal(daemonFileError(code, 'detail').code, expected);
		const provider = new WorkspaceFileSystem(async () => Response.json({ error: { code, message: 'detail' } }, { status: 400 }));
		await assert.rejects(provider.readFile(workspaceUri('host', 'demo', 'file')), { code: expected, message: 'detail' });
	}
	const provider = new WorkspaceFileSystem(async () => { throw new Error('offline'); });
	await assert.rejects(provider.stat(workspaceUri('host', 'demo')), { code: 'Unavailable' });
	const broken = new WorkspaceFileSystem(async () => new Response('bad gateway', { status: 502 }));
	await assert.rejects(broken.readFile(workspaceUri('host', 'demo', 'file')), { code: 'Unavailable' });
	const interrupted = new WorkspaceFileSystem(async () => new Response(new ReadableStream({
		start(controller) { controller.error(new Error('connection lost during read')); }
	})));
	await assert.rejects(interrupted.readFile(workspaceUri('host', 'demo', 'file')), { code: 'Unavailable' });
});

test('placeholder is empty and read-only; unsupported operations explain the limit', async () => {
	const provider = new WorkspaceFileSystem(async () => { throw new Error('must not request'); });
	assert.equal((await provider.stat(placeholder)).permissions, vscode.FilePermission.Readonly);
	assert.deepEqual(await provider.readDirectory(placeholder), []);
	await assert.rejects(provider.readFile(vscode.Uri.parse('ws://outscaled/.vscode/settings.json')), { code: 'FileNotFound' });
	await assert.rejects(provider.writeFile(placeholder, new Uint8Array(), { create: true, overwrite: true }), { code: 'NoPermissions' });
	for (const action of [() => provider.createDirectory(), () => provider.delete(), () => provider.rename()]) {
		assert.throws(action, { code: 'NoPermissions', message: /not supported by wsd yet/ });
	}
	provider.watch().dispose();
});

test('editor memory isolates same-slug workspaces by host, replaces snapshots and persists', () => {
	const a = { host: 'local', slug: 'demo', root: 'file:///test/demo' };
	const b = { host: 'remote', slug: 'demo', root: 'ws://remote/demo/' };
	const memory = new EditorMemory();
	const first = [{ uri: a.root + '/a', viewColumn: 1, active: false }, { uri: a.root + '/dirty', viewColumn: 2, active: true }];
	memory.remember(a, first);
	memory.remember(b, [{ uri: b.root + 'b', original: b.root + 'before', viewColumn: 1, active: true }]);
	first.pop(); // Caller mutations cannot change memory.
	assert.equal(memory.recall(a).length, 2);
	memory.recall(a).pop();
	assert.equal(memory.recall(a).length, 2);
	const restored = new EditorMemory(memory.serialize());
	assert.deepEqual(restored.recall(b), memory.recall(b));
	assert.equal(restored.recall(a).length, 2);
	restored.remember(a, []); // Closing every editor must clear the snapshot.
	assert.deepEqual(restored.recall(a), []);
	assert.equal(restored.recall(b).length, 1);
});

test('selection event exposes previous and current workspace for terminal grid consumers', () => {
	const a = { host: 'local', slug: 'demo', root: 'file:///test/demo' };
	const b = { host: 'remote', slug: 'demo', root: 'ws://remote/demo/' };
	const selection = new WorkspaceSelection(a);
	let change: unknown;
	selection.onDidChangeSelectedWorkspace(({ previous, current }) => { change = { previous, current }; });
	selection.select(b);
	assert.deepEqual(change, { previous: a, current: b });
	assert.deepEqual(selection.current, b);
	selection.dispose();
});


test('switch barriers await snapshot/detach before selection and restoration before resolving', async () => {
	const a = { host: 'local', slug: 'a', root: 'file:///test/a' };
	const b = { host: 'remote', slug: 'b', root: 'ws://remote/b/' };
	const selection = new WorkspaceSelection(a);
	const order: string[] = [];
	selection.onWillChangeSelectedWorkspace(event => {
		assert.deepEqual(selection.current, a);
		event.waitUntil(Promise.resolve().then(() => { order.push('record/detach'); }));
	});
	selection.onDidChangeSelectedWorkspace(event => {
		assert.deepEqual(selection.current, b);
		event.waitUntil(Promise.resolve().then(() => { order.push('restore'); }));
	});
	await selection.prepare(b); order.push('root switch');
	await selection.select(b); order.push('editors');
	assert.deepEqual(order, ['record/detach', 'root switch', 'restore', 'editors']);
	selection.dispose();
});
