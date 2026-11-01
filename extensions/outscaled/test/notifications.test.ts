/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Terminal } from '@outscaled/protocol';
import { TerminalNotifications, paneVisible, registerNotifications } from '../src/notifications';
import { TerminalGrid } from '../src/grid/controller';
import { WorkspaceSelection } from '../src/workspaces/selection';
import { EventEmitter, TabInputTerminal, calls, commands, handlers, settings, window } from './notificationsVscode';
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
		if (kind === 'crashed') agent.state = kind; else agent.status = kind;
		const notifications = new TerminalNotifications(f.service, f.host);
		f.fire(); assert.equal(f.requests.length, 0); assert.equal(f.messages.length, 0);
		server.online = false; f.fire();
		agent.state = 'running'; agent.status = 'idle'; f.fire();
		if (kind === 'crashed') agent.state = kind; else agent.status = kind;
		server.online = true; f.fire(); f.fire();
		assert.equal(f.requests.length, 0); assert.equal(f.messages.length, 0);
		f.service.servers.push({ ...server, host: 'another-example' }); f.fire();
		assert.equal(f.requests.length, 0); assert.equal(f.messages.length, 0);
		agent.state = 'running'; agent.status = 'idle'; f.fire();
		if (kind === 'crashed') agent.state = kind; else agent.status = kind;
		f.fire(); assert.equal(f.requests.length, 2);
		notifications.dispose();
	}
});

test('suppress only when focused AND visible; disabled or suppressed transitions are consumed', () => {
	for (const enabled of [false, true]) for (const focused of [false, true]) for (const visible of [false, true]) {
		const f = fixture(); f.enabled = enabled; f.windowFocused = focused; f.visible = visible;
		const notifications = new TerminalNotifications(f.service, f.host);
		f.service.servers[0].terminals[0].status = 'needs_input'; f.fire();
		assert.equal(f.requests.length, enabled && !(focused && visible) ? 1 : 0);
		assert.equal(f.messages.length, f.requests.length);
		f.enabled = true; f.windowFocused = false; f.fire();
		assert.equal(f.requests.length, enabled && !(focused && visible) ? 1 : 0);
		assert.equal(f.messages.length, f.requests.length);
		notifications.dispose();
	}
});

test('visibility requires the workspace and the bound tab active in any group', () => {
	const workspace = { host: 'local', slug: 'demo' };
	const tab = { input: new TabInputTerminal(), label: 'claude-1' } as any;
	const groups = [{ activeTab: tab }] as any;
	assert.equal(paneVisible(workspace, workspace, tab, groups), true);
	assert.equal(paneVisible(workspace, { ...workspace, host: 'example-alias' }, tab, groups), false);
	assert.equal(paneVisible(workspace, { ...workspace, slug: 'other' }, tab, groups), false);
	assert.equal(paneVisible(workspace, undefined, tab, groups), false);
	assert.equal(paneVisible(workspace, workspace, undefined, groups), false);
	assert.equal(paneVisible(workspace, workspace, { ...tab }, groups), false, 'same label is not the owned tab');
	assert.equal(paneVisible(workspace, workspace, tab, [{ activeTab: undefined }] as any), false);
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
	for (const surface of ['toast', 'message']) for (const stale of ['removed', 'offline', 'disposed', 'dismissed', 'error']) {
		const f = fixture(); let resolve!: (value: any) => void, reject!: (error: Error) => void;
		const result = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
		if (surface === 'toast') f.result = result; else f.messageResult = result;
		const notifications = new TerminalNotifications(f.service, f.host);
		f.service.servers[0].terminals[0].status = 'needs_input'; f.fire();
		if (stale === 'removed') f.service.servers[0].terminals = [];
		if (stale === 'offline') f.service.servers[0].online = false;
		if (stale === 'disposed') notifications.dispose();
		if (stale === 'error') reject(new Error('unsupported')); else resolve(surface === 'toast' ? { shown: stale !== 'dismissed', clicked: stale !== 'dismissed' } : stale !== 'dismissed');
		await settle(); assert.equal(f.focused.length, 0);
		assert.equal(f.errors.length, stale === 'error' ? 1 : 0); notifications.dispose();
	}
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

test('registered clicks switch and restore before focus/open; findPane follows disposal and restored identity', async () => {
	for (const surface of ['toast', 'message']) for (const mode of ['existing', 'open', 'switch', 'restore']) for (const crashed of mode === 'existing' ? [false, true] : [false]) {
		calls.length = 0; handlers.clear(); settings.clear(); window.tabGroups.all = []; window.state.focused = false;
		settings.set('wsPath', process.execPath);
		const f = fixture();
		const service = { ...f.service, request: async () => Response.json([terminal()]) } as any;
		const target = { host: 'local', slug: 'demo', root: 'file:///demo' };
		const switching = mode === 'switch' || mode === 'restore';
		const selection = new WorkspaceSelection(switching ? { host: 'example-alias', slug: 'other', root: 'ws://example-alias/other/' } : target);
		const state = () => { const data = new Map(); return { get: (key: string) => data.get(key), update: async (key: string, value: any) => { data.set(key, value); } }; };
		const context = { subscriptions: [], globalState: state(), workspaceState: state() } as any;
		const grid = new TerminalGrid(context, service, selection, message => { throw new Error(message); });
		try {
			await (grid as any).queue;
			if (mode === 'existing') {
				await commands.executeCommand('outscaled.focusTerminal', target, 'claude-1');
				assert.equal(grid.findPane('local', 'agent-id')?.processId, 1234);
				assert.equal(grid.findPane('example-alias', 'agent-id'), undefined);
				assert.equal(grid.findPane('local', 'other-id'), undefined);
			}
			if (mode === 'restore') grid.memory.remember(target, { layout: { orientation: 0, groups: [{}] },
				panes: [{ name: 'claude-1', viewColumn: 1, terminalId: 'agent-id' }] });
			calls.length = 0;
			handlers.set('outscaled.switchWorkspace', async (workspace: any) => {
				const next = { ...workspace, root: target.root };
				await selection.prepare(next);
				assert.equal(grid.findPane('local', 'agent-id'), undefined, 'detach removes stale client lookup');
				await selection.select(next);
			});
			handlers.set('_outscaled.notify', () => surface === 'toast' ? Promise.resolve({ shown: true, clicked: true }) : new Promise(() => {}));
			handlers.set('message', async () => surface === 'message' ? 'Focus' : undefined);
			registerNotifications(context, service, selection, grid, message => { throw new Error(message); });
			settings.set('notifications.enabled', false);
			service.servers[0].terminals[0].status = 'needs_input'; f.fire();
			assert.equal(calls.filter(call => call[0] === '_outscaled.notify').length, 0);
			settings.delete('notifications.enabled');
			service.servers[0].terminals[0].status = 'idle'; f.fire();
			if (crashed) service.servers[0].terminals[0].state = 'crashed';
			else service.servers[0].terminals[0].status = 'needs_input';
			f.fire();
			await settle(); await (grid as any).queue;
			const request = calls.find(call => call[0] === '_outscaled.notify')![1] as any;
			const message = calls.filter(call => call[0] === 'warning' || call[0] === 'error');
			assert.deepEqual(message, [[crashed ? 'error' : 'warning', `${request.title}: ${request.body}`, 'Focus']]);
			assert.equal(request.processId, mode === 'existing' ? 1234 : undefined);
			const switchIndex = calls.findIndex(call => call[0] === 'outscaled.switchWorkspace');
			const showIndex = calls.findIndex(call => call[0] === 'show');
			assert.ok(showIndex >= 0);
			if (switching) assert.ok(switchIndex >= 0 && showIndex > switchIndex);
			else assert.equal(switchIndex, -1);
			assert.equal(calls.filter(call => call[0] === 'createTerminal').length, mode === 'existing' ? 0 : 1, 'restoration and focus do not duplicate clients');
			assert.equal(selection.current?.host, target.host); assert.equal(selection.current?.slug, target.slug);
			const pane = grid.findPane('local', 'agent-id')!;
			assert.ok(pane.tab);
			assert.equal(paneVisible(target, selection.current, pane.tab, window.tabGroups.all), true);
			await selection.prepare({ host: 'example-alias', slug: 'other', root: 'ws://example-alias/other/' });
			assert.equal(grid.findPane('local', 'agent-id'), undefined, 'disposed client is no longer returned');
		} finally {
			grid.dispose(); selection.dispose(); for (const subscription of context.subscriptions) subscription.dispose();
		}
	}
});
