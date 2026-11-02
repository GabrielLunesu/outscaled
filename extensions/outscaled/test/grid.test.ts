/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { answerTerminal } from '../src/grid/answers';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleSummary, Terminal } from '@outscaled/protocol';
import { PresetStore, presets, expandPreset } from '../src/grid/presets';
import { createSchedules, changeSchedule } from '../src/grid/schedules';
import { agentCommand, planLaunch } from '../src/grid/launch';
import { defaultLaunch } from '../../../src/vs/workbench/contrib/outscaled/common/agentsLaunch.js';
import { spawnSync } from 'node:child_process';
import { createTerminal, ensureTerminal } from '../src/grid/daemonTerminals';
import { findWsPath, attachArgs, attachEnv } from '../src/grid/wsPath';
import { tabStatus } from '../src/grid/status';
import { applyGridRequest, openGridPane, GridMemory } from '../src/grid/memory';
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
	assert.deepEqual(snapshot.workspaces.map(workspace => ({ selected: workspace.selected, path: workspace.path, terminals: workspace.terminals.map(terminal => terminal.id),
		args: workspace.terminals[0].launch?.args })), [
		{ selected: true, path: '/test/demo', terminals: ['agent-id'], args: ['attach', 'demo', 'claude-1'] },
		{ selected: false, path: '/test/demo', terminals: ['agent-id'], args: ['attach', 'demo', 'claude-1', '--on', 'example-alias'] }
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


test('workspace UI is contributed by core; extension retains bridge commands only', () => {
	const { contributes } = JSON.parse(readFileSync('package.json', 'utf8'));
	assert.deepEqual({ views: contributes.views, containers: contributes.viewsContainers, welcome: contributes.viewsWelcome,
		commands: contributes.commands.map((command: { command: string }) => command.command), menus: Object.keys(contributes.menus) }, {
		views: undefined, containers: undefined, welcome: undefined,
		commands: ['outscaled.switchWorkspace', 'outscaled.openGrid', 'outscaled.focusTerminal'], menus: ['commandPalette']
	});
});


test('new launches allocate names, retain background membership and never schedule prematurely', () => {
	const tree = presetLayout('stacked', ['old-a', 'old-b']);
	assert.deepEqual(planLaunch({ ...defaultLaunch(), run: 'always' }, ['claude-1'], tree), {
		panes: [{ name: 'claude-2', command: 'claude', alwaysOn: true }], leaving: ['old-a', 'old-b']
	});
	assert.deepEqual(planLaunch({ ...defaultLaunch(), where: 'add' }, [], tree).leaving, []);
	assert.throws(() => planLaunch({ ...defaultLaunch(), where: 'right' }, [], tree), /focused pane/);
	assert.throws(() => planLaunch({ ...defaultLaunch(), run: 'scheduled' }, [], tree), /not available/);
	const memory = new GridMemory();
	memory.remember(workspace, presetLayout('single', ['new-id']), [terminal.id, 'new-id']);
	const server = { host: 'local', online: true, workspaces: [{ slug: 'demo', path: '/test/demo' }], terminals: [terminal, { ...terminal, id: 'new-id', name: 'claude-2' }] } as ServerState;
	assert.deepEqual(layoutTerminals(agentsSnapshot([server], undefined, new GridMemory(memory.serialize()), '/test/ws', {}).workspaces[0].layout), ['new-id']);
});

test('presets round trip every choice in private TOML, isolated by workspace and host', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'outscaled-presets-'));
	try {
		const store = new PresetStore(directory);
		assert.deepEqual(await store.load('one'), []);
		const choices = { ...defaultLaunch(), run: 'scheduled' as const, interval: '2h', where: 'add' as const, prompt: 'quotes " \' and\nnewlines $()' };
		await store.save('one', 'My preset', choices); await store.save('two', 'My preset', defaultLaunch());
		assert.deepEqual(await new PresetStore(directory).load('one'), [{ name: 'My preset', choices }]);
		await store.save('one', 'My preset', defaultLaunch());
		assert.deepEqual(await store.load('two'), [{ name: 'My preset', choices: defaultLaunch() }]);
		assert.deepEqual(await store.load('one'), [{ name: 'My preset', choices: defaultLaunch() }]);
		assert.ok(readFileSync(join(directory, 'presets.toml'), 'utf8').includes('[[preset]]'));
		writeFileSync(join(directory, 'presets.toml'), '[[preset]]\nname = "bad"\n');
		await assert.rejects(store.load('one'), /Invalid preset/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test('first prompts survive POSIX shells as one literal argument', () => {
	for (const agent of ['claude', 'codex'] as const) {
		for (const prompt of ['hello', 'single \' and double " quotes', '$(touch pwned)', '`touch pwned`', 'line one\nline two', '-p options']) {
			const command = agentCommand(agent, prompt)!;
			const result = spawnSync('/bin/sh', ['-c', `${agent}() { printf '%s\\n' "$#" "$1" "$2"; }; ${command}`], { encoding: 'utf8' });
			assert.deepEqual({ code: result.status, output: result.stdout }, { code: 0, output: `2\n--\n${prompt}\n` });
		}
	}
	assert.equal(agentCommand('shell', 'ignored'), undefined);
});


test('fresh creation sends alwaysOn and refuses to reuse a concurrent winner', async () => {
	const bodies: object[] = [];
	const service = { request: async (_host: string, _path: string, init?: RequestInit) => {
		bodies.push(JSON.parse(init!.body as string)); return new Response(null, { status: 409 });
	} };
	await assert.rejects(createTerminal(service, workspace, { name: 'claude-3', command: 'claude', alwaysOn: true }), /HTTP 409/);
	assert.deepEqual(bodies, [{ name: 'claude-3', command: 'claude', alwaysOn: true }]);
});


test('initial discovery of many sessions stays within the bridge depth limit', () => {
	const terminals = Array.from({ length: 130 }, (_, index) => ({ ...terminal, id: `id-${index}`, name: `claude-${index + 1}` }));
	const server = { host: 'example-alias', online: true, workspaces: [{ slug: 'demo', path: '/test/demo' }], terminals } as ServerState;
	const snapshot = agentsSnapshot([server], undefined, new GridMemory(), '/test/ws', {});
	assert.equal(isAgentsSnapshot(snapshot), true);
	assert.deepEqual(layoutTerminals(snapshot.workspaces[0].layout), terminals.map(terminal => terminal.id));
});


test('background requests persist membership, select neighbours and keep all daemon identities known', () => {
	const memory = new GridMemory();
	const ids = ['a', 'b', 'c'];
	let tree = presetLayout('2+1', ids);
	const focus = applyGridRequest(memory, workspace, tree, { version: 1, action: 'background', workspace: 'local/demo', terminal: 'b' }, ids);
	tree = new GridMemory(memory.serialize()).recall(workspace)!;
	assert.deepEqual({ ids: layoutTerminals(tree), focus, known: memory.known(workspace) }, { ids: ['a', 'c'], focus: 'c', known: ids });
	assert.equal(applyGridRequest(memory, workspace, tree, { version: 1, action: 'background', workspace: 'local/demo', terminal: 'c' }, ids), 'a');
	assert.equal(applyGridRequest(memory, workspace, memory.recall(workspace)!, { version: 1, action: 'background', workspace: 'local/demo', terminal: 'a' }, ids), undefined);
	const server = { host: 'local', online: true, workspaces: [{ slug: 'demo', path: '/test/demo' }], terminals: ids.map(id => ({ ...terminal, id })) } as ServerState;
	assert.deepEqual(agentsSnapshot([server], undefined, new GridMemory(memory.serialize()), '/test/ws', {}).workspaces[0].layout, { type: 'pane', terminal: null });
	assert.throws(() => applyGridRequest(memory, workspace, tree, { version: 1, action: 'background', workspace: 'local/demo', terminal: 'missing' }, ids), /not in the grid/);
	assert.equal(applyGridRequest(memory, workspace, presetLayout('four-across', ['a', 'b', 'c', 'd']), { version: 1, action: 'background', workspace: 'local/demo', terminal: 'b', focused: 'a' }, ['a', 'b', 'c', 'd']), 'a');
});

test('resize requests round trip weights and reset to equal; old trees restore and stale trees fail', () => {
	const memory = new GridMemory();
	const tree = presetLayout('side-by-side', ['a', 'b']);
	const resized = { ...tree, sizes: [3, 1] };
	applyGridRequest(memory, workspace, tree, { version: 1, action: 'resize', workspace: 'local/demo', layout: resized }, ['a', 'b']);
	assert.deepEqual(new GridMemory(memory.serialize()).recall(workspace), resized);
	applyGridRequest(memory, workspace, resized, { version: 1, action: 'resize', workspace: 'local/demo', layout: tree }, ['a', 'b']);
	assert.deepEqual(new GridMemory(memory.serialize()).recall(workspace), tree);
	assert.throws(() => applyGridRequest(memory, workspace, presetLayout('single', ['a']), { version: 1, action: 'resize', workspace: 'local/demo', layout: resized }, ['a', 'b']), /grid changed/);
	assert.deepEqual(memory.recall(workspace), tree);
});


test('scheduled and always-on discovery stays in the strip and retains latest lines', () => {
	const schedule = ScheduleSummary.parse({ workspace: 'demo', name: 'claude-1', source: 'app', readOnly: false, runtime: 'claude-code', every: '30m', prompt: 'Check', command: null, paused: false, lastRun: null, nextRunAt: '2026-01-01T12:00:00.000Z' });
	const server = { host: 'local', online: true, workspaces: [{ slug: 'demo', path: '/test/demo' }], schedules: [schedule], terminals: [{ ...terminal, latestLine: 'Latest message' }, { ...terminal, id: 'always', name: 'claude-2', alwaysOn: true }] } as ServerState;
	const snapshot = agentsSnapshot([server], undefined, new GridMemory(), '/test/ws', {});
	assert.ok(isAgentsSnapshot(snapshot));
	assert.deepEqual({ grid: layoutTerminals(snapshot.workspaces[0].layout), line: snapshot.workspaces[0].terminals[0].latestLine, schedules: snapshot.workspaces[0].schedules }, { grid: [], line: 'Latest message', schedules: [schedule] });
});

test('schedule creation allocates across schedules and terminals, ignores placement, and validates prompts', async () => {
	const summary = { workspace: 'demo', name: 'claude-2', source: 'app' as const, readOnly: false, runtime: 'claude-code' as const, every: '30m', prompt: 'Check', command: null, paused: false, lastRun: null, nextRunAt: '2026-01-01T12:00:00.000Z' };
	const calls: { path: string; method?: string; body?: string }[] = [];
	const service = { request: async (_host: string, path: string, init?: RequestInit) => {
		calls.push({ path, method: init?.method, body: init?.body as string | undefined });
		return Response.json(init?.method === 'GET' ? [summary] : { ...summary, ...JSON.parse(init!.body as string) });
	} };
	await createSchedules(service, workspace, { ...defaultLaunch(), layout: 'side-by-side', agents: ['claude', 'codex'], run: 'scheduled', prompt: 'Literal $() prompt', where: 'right' }, ['claude-1', 'codex-1']);
	assert.deepEqual(calls.slice(1).map(call => ({ method: call.method, body: JSON.parse(call.body!) })), [
		{ method: 'POST', body: { name: 'claude-3', runtime: 'claude-code', every: '30m', prompt: 'Literal $() prompt' } },
		{ method: 'POST', body: { name: 'codex-2', runtime: 'codex', every: '30m', prompt: 'Literal $() prompt' } }
	]);
	for (const choices of [{ ...defaultLaunch(), run: 'scheduled' as const }, { ...defaultLaunch(), run: 'scheduled' as const, agents: ['shell' as const], prompt: 'Check' }]) {
		await assert.rejects(createSchedules(service, workspace, choices, []), /require a prompt/);
	}
});

test('schedule mutations reject read-only edits and duplicate runs, and use encoded API paths', async () => {
	let schedule = ScheduleSummary.parse({ workspace: 'demo', name: 'claude-1', source: 'workspace', readOnly: true, runtime: 'claude-code', every: '30m', prompt: 'Check', command: null, paused: false, lastRun: null, nextRunAt: '2026-01-01T12:00:00.000Z' });
	const calls: { path: string; method?: string; body?: string }[] = [];
	const service = { request: async (_host: string, path: string, init?: RequestInit) => {
		calls.push({ path, method: init?.method, body: init?.body as string | undefined });
		return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(init?.method === 'GET' ? [schedule] : schedule);
	} };
	await assert.rejects(changeSchedule(service, workspace, { version: 1, action: 'editSchedule', workspace: 'demo', name: 'claude-1', prompt: 'New', every: '2h' }), /workspace.toml/);
	await assert.rejects(changeSchedule(service, workspace, { version: 1, action: 'schedule', workspace: 'demo', name: 'claude-1', operation: 'delete' }), /workspace.toml/);
	for (const operation of ['pause', 'resume'] as const) { await changeSchedule(service, workspace, { version: 1, action: 'schedule', workspace: 'demo', name: 'claude-1', operation }); }
	schedule = { ...schedule, source: 'app', readOnly: false };
	await changeSchedule(service, workspace, { version: 1, action: 'editSchedule', workspace: 'demo', name: 'claude-1', prompt: 'New', every: '2h' });
	await changeSchedule(service, workspace, { version: 1, action: 'schedule', workspace: 'demo', name: 'claude-1', operation: 'delete' });
	assert.deepEqual(calls.filter(call => call.method !== 'GET').map(call => [call.path, call.method, call.body && JSON.parse(call.body)]), [
		['workspaces/demo/schedules/claude-1/pause', 'POST', undefined], ['workspaces/demo/schedules/claude-1/resume', 'POST', undefined],
		['workspaces/demo/schedules/claude-1', 'PATCH', { every: '2h', prompt: 'New' }], ['workspaces/demo/schedules/claude-1', 'DELETE', undefined]
	]);
	schedule.lastRun = { id: 'run', status: 'running', startedAt: schedule.nextRunAt!, endedAt: null, result: '' };
	await assert.rejects(changeSchedule(service, workspace, { version: 1, action: 'schedule', workspace: 'demo', name: 'claude-1', operation: 'run' }), /already in progress/);
});


test('Open in Grid inserts right of focus, fills an empty grid, and never duplicates a pane', () => {
	const tree = presetLayout('side-by-side', ['left', 'right']);
	assert.deepEqual(layoutTerminals(openGridPane(tree, 'background', 'left')), ['left', 'background', 'right']);
	assert.deepEqual(layoutTerminals(openGridPane(presetLayout('single', []), 'background')), ['background']);
	assert.deepEqual(openGridPane(tree, 'right', 'left'), tree);
	assert.deepEqual(layoutTerminals(openGridPane(tree, 'background', 'stale-focus')), ['left', 'right', 'background']);
});


test('permission answers use the guarded route, synchronize on success and jump only on conflict', async () => {
	for (const status of [200, 409, 503, 'network'] as const) {
		const calls: object[] = [];
		const work = answerTerminal({ request: async (host, path, init) => {
			calls.push({ host, path, body: JSON.parse(init!.body as string) });
			if (status === 'network') { throw new Error('Network unavailable'); }
			return Response.json(status === 200 ? { question: 'Do you want to proceed?', option: { number: 4, label: 'No' } } : { error: { message: 'Prompt changed' } }, { status });
		}, synchronize: async host => { calls.push({ sync: host }); } }, { host: 'example-alias', slug: 'demo' }, 'claude-1', 'deny',
			async () => { calls.push({ jump: true }); }, message => { calls.push({ message }); });
		if (status === 503 || status === 'network') { await assert.rejects(work, status === 503 ? /HTTP 503/ : /Network unavailable/); }
		else { await work; }
		assert.deepEqual(calls, [{ host: 'example-alias', path: 'workspaces/demo/terminals/claude-1/answer', body: { answer: 'deny' } },
			...(status === 200 ? [{ sync: 'example-alias' }] : status === 409 ? [{ jump: true }, { message: 'The permission prompt changed or is no longer on screen. Review the agent to continue.' }] : [])]);
	}
});
