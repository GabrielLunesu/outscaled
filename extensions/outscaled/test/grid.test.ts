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
import { layouts, presets, expandPreset, EditorGroupLayout } from '../src/grid/presets';
import { ensureTerminal } from '../src/grid/daemonTerminals';
import { findWsPath, attachArgs, attachEnv } from '../src/grid/wsPath';
import { tabStatus, TabStatusChanges } from '../src/grid/status';
import { GridMemory } from '../src/grid/memory';

// Interpret the public editor-layout contract into physical rectangles, without
// assuming that columns and reading order coincide for arbitrary nested layouts.
function rectangles(layout: EditorGroupLayout): number[][] {
	const result: number[][] = [];
	const visit = (groups: EditorGroupLayout['groups'], orientation: number, x: number, y: number, w: number, h: number) => {
		groups.forEach((group, index) => {
			const box = orientation === 0 ? [x + w * index / groups.length, y, w / groups.length, h]
				: [x, y + h * index / groups.length, w, h / groups.length];
			if (group.groups) visit(group.groups, 1 - orientation, box[0], box[1], box[2], box[3]);
			else result.push(box);
		});
	};
	visit(layout.groups, layout.orientation ?? 0, 0, 0, 1, 1);
	return result;
}
test('six layouts have the required geometry and fill left to right, then top to bottom', () => {
	const expected = [
		[[0, 0, 1, 1]],
		[[0, 0, .5, 1], [.5, 0, .5, 1]],
		[[0, 0, 1, .5], [0, .5, 1, .5]],
		[[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]],
		[[0, 0, .25, 1], [.25, 0, .25, 1], [.5, 0, .25, 1], [.75, 0, .25, 1]],
		[[0, 0, .5, .5], [0, .5, .5, .5], [.5, 0, .5, 1]]
	];
	assert.equal(layouts.length, 6);
	for (const [index, layout] of layouts.entries()) {
		const boxes = rectangles(layout.editor);
		assert.deepEqual(layout.columns.map(column => boxes[column - 1]), expected[index]);
	}
});

test('presets expand stable per-command names, commands, and pane assignments', () => {
	assert.deepEqual(expandPreset(presets[0]).panes, [
		{ name: 'claude-1', command: 'claude', viewColumn: 1 }, { name: 'claude-2', command: 'claude', viewColumn: 2 },
		{ name: 'codex-1', command: 'codex', viewColumn: 3 }, { name: 'codex-2', command: 'codex', viewColumn: 4 }
	]);
	assert.deepEqual(expandPreset(presets[1]).panes, [{ name: 'claude-1', command: 'claude', viewColumn: 1 }, { name: 'shell-1', viewColumn: 2 }]);
	assert.equal(presets.length, 8);
	for (const preset of presets.slice(2)) {
		const { layout, panes } = expandPreset(preset);
		assert.equal(panes.length, layout.columns.length);
		assert.deepEqual(panes.map(pane => pane.name), panes.map((_, index) => `shell-${index + 1}`));
		assert.ok(panes.every(pane => pane.command === undefined));
	}
	assert.throws(() => expandPreset({ id: 'bad', label: 'bad', layout: '2x2', commands: ['shell'] }));
});

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
		if (calls[1]) assert.deepEqual(JSON.parse(calls[1].init!.body as string), { name: 'claude-1', command: 'codex' });
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
		for (const setting of [bin, join(root, 'no-exec'), join(root, 'missing')]) await assert.rejects(findWsPath(setting, env, root), /outscaled.wsPath/);
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

test('tab status prioritizes process exits, maps agents, and sends only acknowledged changes', async () => {
	for (const [status, expected] of [['starting', 'working'], ['working', 'working'], ['idle', 'idle'], ['needs_input', 'needs_input']] as const) {
		assert.equal(tabStatus({ ...terminal, status }), expected);
		assert.equal(tabStatus({ ...terminal, status, runtime: null }), 'idle');
		assert.equal(tabStatus({ ...terminal, status, state: 'exited' }), 'idle');
		assert.equal(tabStatus({ ...terminal, status, state: 'crashed' }), 'crashed');
	}
	const changes = new TabStatusChanges();
	const calls: unknown[] = [];
	const send = async (request: unknown) => { calls.push(request); return true; };
	await changes.update(1, terminal, send);
	await changes.update(1, terminal, send);
	await changes.update(1, { ...terminal, status: 'starting' }, send);
	await changes.update(1, { ...terminal, status: 'working' }, send);
	await changes.update(1, { ...terminal, status: 'needs_input' }, send);
	await changes.update(2, terminal, send);
	assert.deepEqual(calls, [{ processId: 1, status: 'idle' }, { processId: 1, status: 'working' }, { processId: 1, status: 'needs_input' }, { processId: 2, status: 'idle' }]);
	changes.forget(1);
	await changes.update(1, terminal, async () => false);
	await changes.update(1, terminal, send);
	assert.equal(calls.length, 5, 'failed core updates can be retried, and closing clears cached PIDs');
});

test('grid memory persists layout, daemon identity and group by workspace without live handles', () => {
	const memory = new GridMemory();
	const { layout, panes } = expandPreset(presets[0]);
	memory.remember(workspace, { layout: layout.editor, preset: presets[0].id, panes: panes.map((pane, index) => ({ ...pane, terminalId: `id-${index}` })) });
	memory.remember({ ...workspace, host: 'example-alias' }, { layout: layouts[0].editor, panes: [] });
	const restored = new GridMemory(memory.serialize());
	assert.equal(restored.recall(workspace)!.panes.length, 4);
	assert.equal(restored.recall({ ...workspace, host: 'example-alias' })!.panes.length, 0);
	restored.recall(workspace)!.panes.pop();
	assert.equal(restored.recall(workspace)!.panes[3].terminalId, 'id-3');
});
