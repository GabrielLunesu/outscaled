/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@outscaled/protocol';
import { presets, expandPreset } from '../src/grid/presets';
import { ensureTerminal } from '../src/grid/daemonTerminals';
import { findWsPath, attachArgs, attachEnv } from '../src/grid/wsPath';
import { tabStatus } from '../src/grid/status';
import { GridMemory } from '../src/grid/memory';
import { agentsSnapshot } from '../src/grid/mapping';
import type { ServerState } from '../src/daemon/state';
import { isAgentsSnapshot } from '../../../src/vs/workbench/contrib/outscaled/common/agentsBridge.js';
import { layoutTerminals, presetLayout } from '../../../src/vs/workbench/contrib/outscaled/common/agentsLayout.js';

const terminal = Terminal.parse({ id: 'agent-id', workspace: 'demo', name: 'claude-1', command: 'claude', session: 'ws-demo-claude-1',
	alwaysOn: false, state: 'running', runtime: 'claude-code', status: 'idle', statusChangedAt: '2026-01-01T00:00:00.000Z', restarts: 0, pid: 123,
	createdAt: '2026-01-01T00:00:00.000Z' });
const workspace = { host: 'local', slug: 'demo' };
test('reuse running names regardless of command, restart exited names, and resolve create races', async () => {
	for (const state of ['running', 'exited', 'crashed'] as const) {
		const calls: { host: string; path: string; init?: RequestInit }[] = [];
		const service = { request: async (host: string, path: string, init?: RequestInit) => {
			calls.push({ host, path, init });
			return Response.json(init ? terminal : [{ ...terminal, state }]);
		} };
		assert.equal((await ensureTerminal(service, workspace, { name: terminal.name, command: 'codex' })).id, terminal.id);
		assert.equal(calls.length, state === 'running' ? 1 : 2);
		assert.equal(calls[0].host, 'local'); assert.equal(calls[0].path, 'workspaces/demo/terminals');
		if (calls[1]) {assert.deepEqual(JSON.parse(calls[1].init!.body as string), { name: 'claude-1', command: 'codex' });}
	}
	const responses = [Response.json([]), new Response(null, { status: 409 }), Response.json([terminal])];
	assert.equal((await ensureTerminal({ request: async () => responses.shift()! }, workspace, { name: terminal.name })).id, terminal.id);
	await assert.rejects(ensureTerminal({ request: async () => new Response(null, { status: 503 }) }, workspace, { name: 'shell-1' }), /list terminals/);
	const conflict = [Response.json([]), new Response(null, { status: 409 }), Response.json([{ ...terminal, state: 'restarting' }])];
	await assert.rejects(ensureTerminal({ request: async () => conflict.shift()! }, workspace, { name: terminal.name }), /HTTP 409/);
});

test('ws lookup honors explicit paths, PATH order, Dock fallbacks and executable file checks', async () => {
	const root = mkdtempSync(join(tmpdir(), 'outscaled-path-'));
	try {
		const bin = join(root, 'bin'); mkdirSync(bin);
		const local = join(root, '.local/bin'); mkdirSync(local, { recursive: true });
		writeFileSync(join(bin, 'ws'), '', { mode: 0o755 });
		writeFileSync(join(local, 'ws'), '', { mode: 0o755 });
		writeFileSync(join(root, 'no-exec'), '', { mode: 0o644 });
		const env = { PATH: bin };
		assert.equal(await findWsPath(undefined, env, root), join(bin, 'ws'));
		assert.equal(await findWsPath('~/.local/bin/ws', env, root), join(local, 'ws'));
		assert.equal(await findWsPath('ws', env, root), join(bin, 'ws'));
		assert.equal(await findWsPath('', { PATH: '/usr/bin:/bin' }, root), join(local, 'ws'));
		for (const setting of [bin, join(root, 'no-exec'), join(root, 'missing')]) {await assert.rejects(findWsPath(setting, env, root), /outscaled.wsPath/);}
		for (const fallback of ['/opt/homebrew/bin/ws', '/usr/local/bin/ws']) {
			assert.equal(await findWsPath(undefined, {}, root, async path => path === fallback), fallback);
		}
		await assert.rejects(findWsPath(undefined, {}, root, async () => false), /Could not find ws/);
	} finally { rmSync(root, { recursive: true, force: true }); }
	assert.deepEqual(attachArgs('local', 'demo', 'claude-1'), ['attach', 'demo', 'claude-1']);
	assert.deepEqual(attachArgs('example-alias', 'demo', 'codex-1'), ['attach', 'demo', 'codex-1', '--on', 'example-alias']);
	assert.deepEqual(attachEnv({ WSD_PORT: '12345', WSD_TMUX_SOCKET: '/test/tmux.sock', OTHER: 'private' }), { WSD_PORT: '12345', WSD_TMUX_SOCKET: '/test/tmux.sock' });
	assert.deepEqual(attachEnv({}), {});
});

test('pane statuses prioritize process exits and map agent runtime states', () => {
	assert.deepEqual(['idle', 'working', 'starting', 'needs_input'].map(status => tabStatus({ ...terminal, status } as typeof terminal)), ['idle', 'working', 'working', 'needs_input']);
	assert.deepEqual(['exited', 'crashed'].map(state => tabStatus({ ...terminal, state } as typeof terminal)), ['idle', 'crashed']);
});

test('presets assign stable per-runtime names in fill order', () => {
	assert.deepEqual(expandPreset(presets[0]).panes, [
		{ name: 'claude-1', command: 'claude' }, { name: 'claude-2', command: 'claude' },
		{ name: 'codex-1', command: 'codex' }, { name: 'codex-2', command: 'codex' }
	]);
	assert.equal(presets.length, 8);
	assert.throws(() => expandPreset({ id: 'bad', label: 'bad', layout: '2x2', commands: ['shell'] }));
});

test('mapping isolates workspaces, statuses and local/VPS attach descriptors', () => {
	const memory = new GridMemory();
	const servers = ['local', 'example-alias'].map(host => ({ host, online: true, workspaces: [{ slug: 'demo', path: '/test/demo' }],
		terminals: [terminal, { ...terminal, id: 'other', workspace: 'other' }] })) as ServerState[];
	const snapshot = agentsSnapshot(servers, { ...workspace, root: 'file:///test/demo' }, memory, '/test/ws', { WSD_PORT: '12345' });
	assert.ok(isAgentsSnapshot(snapshot));
	assert.deepEqual(snapshot.workspaces.map(workspace => ({ selected: workspace.selected, terminals: workspace.terminals.map(terminal => terminal.id),
		args: workspace.terminals[0].launch?.args })), [
		{ selected: true, terminals: ['agent-id'], args: ['attach', 'demo', 'claude-1'] },
		{ selected: false, terminals: ['agent-id'], args: ['attach', 'demo', 'claude-1', '--on', 'example-alias'] }
	]);
});

test('grid memory retains topology and only reconciles original daemon identities', () => {
	const memory = new GridMemory();
	memory.remember(workspace, presetLayout('2x2', ['one', 'two', 'three', 'four']));
	const restored = new GridMemory(memory.serialize());
	assert.deepEqual(layoutTerminals(restored.reconcile(workspace, new Set(['one', 'three', 'replacement']))!), ['one', 'three']);
	assert.deepEqual(layoutTerminals(memory.recall(workspace)!), ['one', 'two', 'three', 'four']);
	assert.equal(new GridMemory({ bad: {} } as never).recall(workspace), undefined);
});


test('same-slug grids remain isolated by server after persistence', () => {
	const memory = new GridMemory();
	memory.remember(workspace, presetLayout('single', ['local-id']));
	memory.remember({ ...workspace, host: 'example-alias' }, presetLayout('stacked', ['remote-a', 'remote-b']));
	const restored = new GridMemory(memory.serialize());
	assert.deepEqual([layoutTerminals(restored.recall(workspace)!), layoutTerminals(restored.recall({ ...workspace, host: 'example-alias' })!)], [['local-id'], ['remote-a', 'remote-b']]);
});


test('crashed daemon identities retain grid membership without launching an attach client', () => {
	const memory = new GridMemory();
	memory.remember(workspace, presetLayout('single', [terminal.id]));
	const server = { host: 'local', online: true, workspaces: [{ slug: 'demo', path: '/test/demo' }], terminals: [{ ...terminal, state: 'crashed' }] } as ServerState;
	const snapshot = agentsSnapshot([server], undefined, memory, '/test/ws', {});
	assert.ok(isAgentsSnapshot(snapshot));
	assert.deepEqual({ status: snapshot.workspaces[0].terminals[0].status, launch: snapshot.workspaces[0].terminals[0].launch, ids: layoutTerminals(snapshot.workspaces[0].layout) },
		{ status: 'crashed', launch: undefined, ids: [terminal.id] });
});
