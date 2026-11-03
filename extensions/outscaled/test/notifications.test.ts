/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Terminal } from '@outscaled/protocol';
import type * as vscode from 'vscode';
import type { DaemonService } from '../src/daemon/service';
import type { AgentsSnapshot } from '../../../src/vs/workbench/contrib/outscaled/common/agentsBridge.js';
import type { WorkspaceLocation } from '../src/workspaces/uri';
import { TerminalNotifications, registerNotifications } from '../src/notifications';
import { TerminalGrid } from '../src/grid/controller';
import { WorkspaceSelection } from '../src/workspaces/selection';
import { EventEmitter, calls, commands, handlers, settings, window } from './notificationsVscode';
import type { ServerState } from '../src/daemon/state';

const terminal = () => Terminal.parse({ id: 'agent-id', workspace: 'demo', name: 'claude-1', command: 'claude', session: 'ws-demo-claude-1',
	alwaysOn: false, state: 'running', runtime: 'claude-code', status: 'idle', statusChangedAt: '2026-01-01T00:00:00.000Z', restarts: 0, pid: 123, createdAt: '2026-01-01T00:00:00.000Z' });
function fixture() {
	const changes = new EventEmitter<void>();
	const servers: ServerState[] = ['local', 'example-alias'].map(host => ({ host, online: true, workspaces: [], terminals: [terminal()] }));
	const messages: { request: unknown; kind: string }[] = [];
	const requests: any[] = [], focused: any[] = [], errors: string[] = [];
	let enabled = true, windowFocused = false, visible = false;
	let result: PromiseLike<{ shown: boolean; clicked: boolean }> = Promise.resolve({ shown: true, clicked: false });
	let messageResult: PromiseLike<boolean> = Promise.resolve(false);
	const service = { servers, onDidChange: changes.event };
	const host = { enabled: () => enabled, focused: () => windowFocused,
		pane: () => ({ visible, processId: 1234 }),
		notify: (request: unknown) => { requests.push(request); return result; },
		message: (request: unknown, kind: string) => { messages.push({ request, kind }); return messageResult; },
		focus: async (...args: unknown[]) => { focused.push(args); }, log: (message: string) => errors.push(message) };
	return { service, host, requests, messages, focused, errors, fire: () => changes.fire(),
		set enabled(value: boolean) { enabled = value; }, set windowFocused(value: boolean) { windowFocused = value; },
		set messageResult(value: typeof messageResult) { messageResult = value; },
		set visible(value: boolean) { visible = value; }, set result(value: typeof result) { result = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function gridContext(): vscode.ExtensionContext {
	const state = () => { const data = new Map<string, unknown>(); return { get: (key: string) => data.get(key), update: async (key: string, value: unknown) => { data.set(key, value); } }; };
	return { subscriptions: [], globalState: state(), workspaceState: state() } as unknown as vscode.ExtensionContext;
}


test('notify on transitions across servers, once per entry, with stable per-terminal/kind ids', async () => {
	const f = fixture(), notifications = new TerminalNotifications(f.service, f.host);
	const [local, remote] = f.service.servers;
	assert.equal(f.requests.length, 0); assert.equal(f.messages.length, 0);
	local.terminals[0].status = 'needs_input'; f.fire(); f.fire();
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.requests[0], { id: 'outscaled:["local","agent-id","needs_input"]', title: 'claude-1 · demo · local', body: 'Needs your input', processId: 1234 });
	local.terminals[0].status = 'working'; f.fire();
	local.terminals[0].status = 'needs_input'; f.fire();
	assert.equal(f.requests[1].id, f.requests[0].id);
	local.terminals[0].state = 'crashed'; f.fire(); f.fire();
	assert.equal(f.requests[2].id, 'outscaled:["local","agent-id","crashed"]');
	assert.equal(f.requests[2].body, 'Crashed');
	local.terminals[0].state = 'running'; local.terminals[0].status = 'idle'; f.fire();
	local.terminals[0].state = 'crashed'; f.fire();
	assert.equal(f.requests[3].id, f.requests[2].id);
	remote.terminals[0].status = 'needs_input'; f.fire();
	assert.equal(f.requests.length, 5);
	assert.equal(f.requests[4].title, 'claude-1 · demo · example-alias');
	assert.notEqual(f.requests[4].id, f.requests[0].id);
	assert.deepEqual(f.messages, f.requests.map(request => ({ request, kind: request.body === 'Crashed' ? 'crashed' : 'needs_input' })));
	await settle(); assert.deepEqual(f.errors, []); notifications.dispose();
});

test('startup, reconnect, added-server snapshots and offline mutations establish silent baselines', () => {
	for (const kind of ['needs_input', 'crashed'] as const) {
		const f = fixture();
		const server = f.service.servers[0], agent = server.terminals[0];
		if (kind === 'crashed') {agent.state = kind;} else {agent.status = kind;}
		const notifications = new TerminalNotifications(f.service, f.host);
		f.fire(); assert.equal(f.requests.length, 0); assert.equal(f.messages.length, 0);
		server.online = false; f.fire();
		agent.state = 'running'; agent.status = 'idle'; f.fire();
		if (kind === 'crashed') {agent.state = kind;} else {agent.status = kind;}
		server.online = true; f.fire(); f.fire();
		assert.equal(f.requests.length, 0); assert.equal(f.messages.length, 0);
		f.service.servers.push({ ...server, host: 'another-example' }); f.fire();
		assert.equal(f.requests.length, 0); assert.equal(f.messages.length, 0);
		agent.state = 'running'; agent.status = 'idle'; f.fire();
		if (kind === 'crashed') {agent.state = kind;} else {agent.status = kind;}
		f.fire(); assert.equal(f.requests.length, 2);
		notifications.dispose();
	}
});

test('suppress only when focused AND visible; disabled or suppressed transitions are consumed', () => {
	for (const enabled of [false, true]) {for (const focused of [false, true]) {for (const visible of [false, true]) {
		const f = fixture(); f.enabled = enabled; f.windowFocused = focused; f.visible = visible;
		const notifications = new TerminalNotifications(f.service, f.host);
		f.service.servers[0].terminals[0].status = 'needs_input'; f.fire();
		assert.equal(f.requests.length, enabled && !(focused && visible) ? 1 : 0);
		assert.equal(f.messages.length, f.requests.length);
		f.enabled = true; f.windowFocused = false; f.fire();
		assert.equal(f.requests.length, enabled && !(focused && visible) ? 1 : 0);
		assert.equal(f.messages.length, f.requests.length);
		notifications.dispose();
	}}}
});

test('pending toasts do not block each other; only clicks route; stale/disposed clicks and command errors are handled', async () => {
	const f = fixture(); let resolve!: (value: any) => void;
	f.result = new Promise(done => { resolve = done; });
	const notifications = new TerminalNotifications(f.service, f.host);
	for (const server of f.service.servers) { server.terminals[0].status = 'needs_input'; f.fire(); }
	assert.equal(f.requests.length, 2);
	resolve({ shown: true, clicked: true }); await settle();
	assert.deepEqual(f.focused, [[{ host: 'local', slug: 'demo' }, 'claude-1'], [{ host: 'example-alias', slug: 'demo' }, 'claude-1']]);
	notifications.dispose();
	for (const surface of ['toast', 'message']) {for (const stale of ['removed', 'offline', 'disposed', 'dismissed', 'error']) {
		const f = fixture(); let resolve!: (value: any) => void, reject!: (error: Error) => void;
		const result = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
		if (surface === 'toast') {f.result = result;} else {f.messageResult = result;}
		const notifications = new TerminalNotifications(f.service, f.host);
		f.service.servers[0].terminals[0].status = 'needs_input'; f.fire();
		if (stale === 'removed') {f.service.servers[0].terminals = [];}
		if (stale === 'offline') {f.service.servers[0].online = false;}
		if (stale === 'disposed') {notifications.dispose();}
		if (stale === 'error') {reject(new Error('unsupported'));} else {resolve(surface === 'toast' ? { shown: stale !== 'dismissed', clicked: stale !== 'dismissed' } : stale !== 'dismissed');}
		await settle(); assert.equal(f.focused.length, 0);
		assert.equal(f.errors.length, stale === 'error' ? 1 : 0); notifications.dispose();
	}}
});

test('in-app Focus works while the OS toast remains pending or rejects', async () => {
	for (const failure of [false, true]) {
		const f = fixture();
		f.result = failure ? Promise.reject(new Error('toast unavailable')) : new Promise(() => {});
		f.messageResult = Promise.resolve(true);
		const notifications = new TerminalNotifications(f.service, f.host);
		f.service.servers[0].terminals[0].status = 'needs_input'; f.fire(); f.fire();
		assert.equal(f.messages.length, 1);
		await settle();
		assert.deepEqual(f.focused, [[{ host: 'local', slug: 'demo' }, 'claude-1']]);
		assert.equal(f.errors.length, failure ? 1 : 0);
		notifications.dispose();
	}
});

test('bridge publishes a focus request after switching for both notification surfaces', async () => {
	for (const surface of ['toast', 'message']) {
		calls.length = 0; handlers.clear(); settings.clear(); window.state.focused = false;
		settings.set('wsPath', process.execPath);
		const f = fixture();
		for (const server of f.service.servers) {server.workspaces = [{ slug: 'demo', path: '/test/demo' }] as ServerState['workspaces'];}
		const service = { ...f.service, selectChanges: async () => {}, synchronize: async () => {}, request: async () => Response.json([terminal()]) } as DaemonService;
		const target = { host: 'local', slug: 'demo', root: 'file:///test/demo' };
		const selection = new WorkspaceSelection({ ...target, host: 'example-alias' });
		const context = gridContext();
		handlers.set('_outscaled.agents.publish', () => ({ version: 1, ok: true, panes: [] }));
		const grid = new TerminalGrid(context, service, selection, message => { throw new Error(message); });
		try {
			await grid.flush();
			grid.memory.remember({ host: 'local', slug: 'demo' }, { type: 'pane', terminal: null }, ['agent-id']);
			handlers.set('outscaled.switchWorkspace', async (workspace: WorkspaceLocation) => { const next = { ...workspace, root: target.root }; await selection.prepare(next); await selection.select(next); });
			handlers.set('_outscaled.notify', () => surface === 'toast' ? Promise.resolve({ shown: true, clicked: true }) : new Promise(() => {}));
			handlers.set('message', async () => surface === 'message' ? 'Focus' : undefined);
			registerNotifications(context, service, grid, message => { throw new Error(message); });
			f.service.servers[0].terminals[0].status = 'needs_input'; f.fire();
			await settle(); await grid.flush(); await settle();
			const focused = calls.filter(call => call[0] === '_outscaled.agents.publish' && (call[1] as AgentsSnapshot).focus);
			assert.equal(focused.length, 1);
			assert.deepEqual((focused[0][1] as AgentsSnapshot).focus, { workspace: '["local","demo"]', terminal: 'agent-id' });
			assert.deepEqual((focused[0][1] as AgentsSnapshot).workspaces.find(workspace => workspace.server === 'local')?.layout, { type: 'pane', terminal: null }, 'notification Focus leaves background membership intact');
			assert.ok(calls.findIndex(call => call[0] === 'outscaled.switchWorkspace') < calls.indexOf(focused[0]));
		} finally { grid.dispose(); selection.dispose(); for (const subscription of context.subscriptions) {subscription.dispose();} }
	}
});

test('a late cross-workspace focus cannot override a newer agent click', async () => {
	calls.length = 0; handlers.clear(); settings.clear(); settings.set('wsPath', process.execPath);
	const f = fixture();
	const first = terminal(), second = { ...terminal(), id: 'second-agent', name: 'claude-2', session: 'ws-demo-claude-2' };
	for (const server of f.service.servers) {
		server.workspaces = [{ slug: 'demo', path: '/test/demo' }] as ServerState['workspaces']; server.terminals = [first, second];
	}
	const service = { ...f.service, selectChanges: async () => {}, synchronize: async () => {}, request: async () => Response.json([first, second]) } as DaemonService;
	const target = { host: 'local', slug: 'demo', root: 'file:///test/demo' };
	const selection = new WorkspaceSelection({ ...target, host: 'example-alias' });
	const context = gridContext();
	handlers.set('_outscaled.agents.publish', () => ({ version: 1, ok: true, panes: [] }));
	const grid = new TerminalGrid(context, service, selection, message => { throw new Error(message); });
	let release!: () => void, ready!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	const visible = new Promise<void>(resolve => { ready = resolve; });
	try {
		await grid.flush();
		let switches = Promise.resolve();
		handlers.set('outscaled.switchWorkspace', () => {
			switches = switches.then(async () => {
				if (selection.current?.host === target.host) { return; }
				await selection.prepare(target); await selection.select(target); ready(); await held;
			});
			return switches;
		});
		const earlier = commands.executeCommand('outscaled.focusTerminal', target, first.name);
		await visible;
		const newer = commands.executeCommand('outscaled.focusTerminal', target, second.name);
		release(); await Promise.all([earlier, newer]); await grid.flush();
		assert.deepEqual(calls.filter(call => call[0] === '_outscaled.agents.publish' && (call[1] as AgentsSnapshot).focus).map(call => (call[1] as AgentsSnapshot).focus),
			[{ workspace: '["local","demo"]', terminal: second.id }]);
	} finally { release(); grid.dispose(); selection.dispose(); }
});


test('a rapid return during root preparation waits for the serialized switch back', async () => {
	calls.length = 0; handlers.clear(); settings.clear(); settings.set('wsPath', process.execPath);
	const f = fixture();
	for (const server of f.service.servers) { server.workspaces = [{ slug: 'demo', path: '/test/demo' }] as ServerState['workspaces']; }
	const service = { ...f.service, selectChanges: async () => {}, synchronize: async () => {}, request: async () => Response.json([terminal()]) } as DaemonService;
	const old = { host: 'local', slug: 'demo', root: 'file:///test/demo' };
	const target = { ...old, host: 'example-alias' };
	const selection = new WorkspaceSelection(old);
	const context = gridContext();
	let release!: () => void, visible!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	const prepared = new Promise<void>(resolve => { visible = resolve; });
	handlers.set('_outscaled.agents.publish', async (snapshot: AgentsSnapshot) => {
		if (snapshot.workspaces.some(workspace => workspace.selected && workspace.server === target.host) && selection.current?.host === old.host) { visible(); await held; }
		return { version: 1, ok: true, panes: [] };
	});
	const grid = new TerminalGrid(context, service, selection, message => { throw new Error(message); });
	let switches = Promise.resolve();
	handlers.set('outscaled.switchWorkspace', (workspace: WorkspaceLocation) => {
		switches = switches.then(async () => {
			if (selection.current?.host === workspace.host) { return; }
			const next = { ...workspace, root: old.root }; await selection.prepare(next); await selection.select(next);
		});
		return switches;
	});
	try {
		await grid.flush();
		const first = commands.executeCommand('outscaled.focusTerminal', target, 'claude-1');
		await prepared;
		const last = commands.executeCommand('outscaled.focusTerminal', old, 'claude-1');
		release(); await Promise.all([first, last]); await grid.flush();
		assert.deepEqual([selection.current?.host, calls.filter(call => call[0] === '_outscaled.agents.publish' && (call[1] as AgentsSnapshot).focus).map(call => (call[1] as AgentsSnapshot).focus)],
			['local', [{ workspace: '["local","demo"]', terminal: 'agent-id' }]]);
	} finally { release(); grid.dispose(); selection.dispose(); }
});
