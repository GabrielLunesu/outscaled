/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Health, ScheduleSummary, StreamMessage, Terminal, Workspace } from '@outscaled/protocol';
import { Backoff, localPort, parseServers, validateSshTarget } from '../src/daemon/servers';
import { applyMessage, ServerState } from '../src/daemon/state';
import { sshArgs, Tunnel } from '../src/daemon/tunnel';
import { Connection } from '../src/daemon/connection';
import { DaemonService } from '../src/daemon/service';

const time = '2026-01-01T00:00:00.000Z';
const health = Health.parse({ name: 'test', version: 'test', uptimeSec: 1,
	cpu: { cores: 1, load1: 0, usagePct: 0 }, ram: { totalBytes: 1, usedBytes: 0 },
	disk: { path: '/', totalBytes: 1, usedBytes: 0 }, terminals: { total: 1, running: 1 } });
const workspace = Workspace.parse({ slug: 'demo', path: '/test/demo', repo: null, inPlace: false, createdAt: time });
const terminal = Terminal.parse({ id: 'test-terminal', workspace: 'demo', name: 'agent', command: 'claude', session: 'ws-demo-agent',
	alwaysOn: false, state: 'running', runtime: 'claude-code', status: 'idle', statusChangedAt: time, restarts: 0, pid: 1, createdAt: time });
const status = (newStatus: string, at = '2026-01-01T00:00:01.000Z') => StreamMessage.parse({ id: 'event', type: 'terminal.status',
	workspace: 'demo', terminal: terminal.id, payload: { newStatus }, time: at, acked: false });
async function until(check: () => boolean, timeout = 7000) {
	const deadline = Date.now() + timeout;
	while (!check()) { if (Date.now() > deadline) {throw new Error('Timed out');} await delay(20); }
}

test('TOML accepts CLI targets, comments, quoting, file order and deduplication', () => {
	assert.deepEqual(parseServers(''), { hosts: ['local'], errors: [] });
	assert.deepEqual(parseServers(`# comment\n[[server]]\nhost = "example-alias"\n[[server]]\nhost = 'user@host'\n[[server]]\nhost = "[::1]"`),
		{ hosts: ['local', 'example-alias', 'user@host', '[::1]'], errors: [] });
	const parsed = parseServers(`[[server]]\nhost = "good"\n[[server]]\nhost = "-oProxyCommand=bad"\n[[server]]\nhost = "local"\n[[server]]\nhost = "good"\n[[server]]\nhost = 1\n[[server]]\nhost = "other"\nextra = true\n[[server]]\nhost = "last"`);
	assert.deepEqual(parsed.hosts, ['local', 'good', 'last']);
	assert.equal(parsed.errors.length, 5);
	assert.equal(parseServers('server = "wrong"').errors.length, 1);
	assert.equal(parseServers('extra = true').errors.length, 1);
	assert.throws(() => parseServers('[[server]'));
	for (const host of ['-bad', 'ssh://host', 'host command', 'host\ncommand', 'host;command', '$(command)']) {assert.throws(() => validateSshTarget(host));}
});

test('local port follows CLI validation', () => {
	assert.equal(localPort(undefined), 7770);
	assert.equal(localPort('12345'), 12345);
	for (const value of ['', '0', '65536', '1.5', '1x', '-1']) {assert.throws(() => localPort(value));}
});

test('status, health and workspace invalidation', () => {
	const state: ServerState = { host: 'local', online: true, workspaces: [workspace], terminals: [{ ...terminal }] };
	assert.equal(applyMessage(state, status('needs_input')), false);
	assert.equal(state.terminals[0].status, 'needs_input');
	applyMessage(state, status('idle', time)); // An older snapshot/event cannot undo a newer status.
	assert.equal(state.terminals[0].status, 'needs_input');
	applyMessage(state, status('working', '2026-01-01T00:00:02.000Z'));
	assert.equal(state.terminals[0].status, 'working');
	assert.equal(applyMessage(state, StreamMessage.parse({ type: 'workspace.changed', workspace: 'demo' })), true);
	applyMessage(state, StreamMessage.parse({ type: 'server.health', payload: health }));
	assert.deepEqual(state.health, health);
	assert.throws(() => applyMessage(state, status('unknown')));
	state.terminals = [];
	assert.equal(applyMessage(state, status('idle')), true);
});

test('retry delay grows, caps at five minutes and resets on recovery', () => {
	const backoff = new Backoff();
	assert.deepEqual(Array.from({ length: 6 }, () => backoff.next()), [1000, 5000, 30000, 300000, 300000, 300000]);
	backoff.reset(); assert.equal(backoff.next(), 1000);
});

test('SSH argv owns a foreground loopback tunnel with CLI safety options', () => {
	const args = sshArgs('user@example-alias', 23456);
	assert.equal(args.at(-1), 'user@example-alias');
	assert.deepEqual(args.slice(-3), ['-L', '127.0.0.1:23456:127.0.0.1:7770', 'user@example-alias']);
	for (const option of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ConnectTimeout=10', 'ConnectionAttempts=1',
		'ServerAliveInterval=5', 'ServerAliveCountMax=2', 'ForkAfterAuthentication=no', 'ControlMaster=no', 'ControlPath=none', 'PermitLocalCommand=no']) {
		assert.equal(args[args.indexOf(option) - 1], '-o');
	}
	assert.ok(args.includes('-N')); assert.ok(args.includes('-T')); assert.ok(!args.includes('-f'));
	assert.throws(() => sshArgs('-bad', 23456));
});

test('stream precedes snapshot, replays in-flight status, refetches membership and recovers without replay', async () => {
	let connected = 0;
	let requests = 0;
	let schedules: ScheduleSummary[] = [];
	let terminals = [{ ...terminal }];
	let workspaces = [workspace];
	let changes = { attributionAvailable: true, files: [] as { path: string; originalPath: null; status: 'modified'; agents: [] }[] };
	let delaySnapshot = true;
	const server = createServer((req, res) => {
		assert.ok(connected > 0, 'stream opens before any snapshot request');
		requests++;
		const value = req.url?.endsWith('/changes') ? changes : req.url?.endsWith('/schedules') ? schedules.filter(schedule => req.url === `/v1/workspaces/${schedule.workspace}/schedules`) : req.url === '/v1/health' ? health : req.url === '/v1/workspaces' ? workspaces : terminals;
		const body = JSON.stringify(value);
		if (req.url === '/v1/terminals' && delaySnapshot) {
			delaySnapshot = false;
			for (const socket of wss.clients) {socket.send(JSON.stringify(status('needs_input')));}
			setTimeout(() => res.end(body), 100);
		} else {res.end(body);}
	});
	const wss = new WebSocketServer({ server, path: '/v1/stream' });
	wss.on('connection', () => { connected++; });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as { port: number };
	const connection = new Connection('local', () => {}, () => {});
	try {
		connection.setEndpoint(`http://127.0.0.1:${address.port}`);
		const earlyRead = connection.request('health');
		await until(() => connection.state.online);
		assert.deepEqual(await (await earlyRead).json(), health, 'startup file clients wait for the shared connection');
		assert.equal(connection.state.terminals[0].status, 'needs_input');
		const send = (message: unknown) => { for (const socket of wss.clients) {socket.send(JSON.stringify(message));} };
		await connection.selectChanges('demo');
		assert.deepEqual(connection.state.changes?.demo, changes);
		assert.equal(connection.state.changes?.['constructor'], undefined, 'valid workspace slugs cannot inherit cache entries');
		changes = { attributionAvailable: true, files: [{ path: 'changed.ts', originalPath: null, status: 'modified', agents: [] }] };
		send({ type: 'workspace.changes', workspace: 'demo' });
		await until(() => connection.state.changes?.demo.files.length === 1);
		send({ type: 'server.health', payload: { ...health, uptimeSec: 99 } });
		await until(() => connection.state.health?.uptimeSec === 99);
		schedules = [ScheduleSummary.parse({ workspace: 'demo', name: 'check', runtime: 'codex', source: 'app', readOnly: false, every: '30m', prompt: 'Check', command: null, paused: false, lastRun: null, nextRunAt: time })];
		send({ id: 'run-event', type: 'run.started', workspace: 'demo', terminal: terminal.id, payload: {}, time, acked: false });
		await until(() => connection.state.schedules?.length === 1);
		assert.deepEqual(connection.state.schedules, schedules);
		send({ type: 'terminal.latest_line', workspace: 'demo', terminal: terminal.id, payload: { latestLine: 'Stream line' } });
		await until(() => connection.state.terminals[0].latestLine === 'Stream line');
		terminals = [{ ...terminal, state: 'exited' }];
		workspaces = [workspace, { ...workspace, slug: 'second' }];
		send({ type: 'workspace.changed', workspace: 'second' });
		await until(() => connection.state.workspaces.length === 2 && connection.state.terminals[0].state === 'exited');
		assert.equal(connection.state.terminals[0].state, 'exited');
		for (const socket of wss.clients) {socket.close();}
		await until(() => !connection.state.online);
		terminals = [{ ...terminal, status: 'working' }];
		await until(() => connection.state.online && connected === 2);
		assert.equal(connection.state.terminals[0].status, 'working');
		assert.deepEqual(connection.state.changes?.demo, changes);
		assert.ok(requests >= 9);
		// Schema errors take only this connection offline, rather than escaping the callback.
		send({ type: 'server.health', payload: {} });
		await until(() => !connection.state.online);
		assert.match(connection.state.error!, /Invalid stream/);
	} finally {
		connection.dispose();
		for (const socket of wss.clients) {socket.terminate();}
		await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
	}
});

test('mutation barrier refetches membership after an older in-flight snapshot', async () => {
	let terminals: Terminal[] = [terminal];
	let release: (() => void) | undefined;
	let hold = false;
	const server = createServer((req, res) => {
		const body = JSON.stringify(req.url?.endsWith('/schedules') ? [] : req.url === '/v1/health' ? health : req.url === '/v1/workspaces' ? [workspace] : terminals);
		if (req.url === '/v1/terminals' && hold) {
			hold = false;
			release = () => res.end(body);
		} else { res.end(body); }
	});
	const stream = new WebSocketServer({ server, path: '/v1/stream' });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const connection = new Connection('local', () => {}, () => {});
	try {
		connection.setEndpoint(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
		await until(() => connection.state.online);
		hold = true;
		connection.refresh();
		await until(() => !!release);
		terminals = [terminal, { ...terminal, id: 'new', name: 'second', session: 'ws-demo-second' }];
		const barrier = connection.synchronize();
		release!();
		await barrier;
		assert.deepEqual(connection.state.terminals.map(terminal => terminal.id), ['test-terminal', 'new']);
		terminals = [];
		await connection.synchronize();
		assert.deepEqual(connection.state.terminals, []);
	} finally {
		connection.dispose();
		for (const socket of stream.clients) { socket.terminate(); }
		await new Promise<void>(resolve => stream.close(() => server.close(() => resolve())));
	}
});

test('missing config means local only; atomic saves reload and malformed saves retain connections', async () => {
	const root = mkdtempSync(join(tmpdir(), 'outscaled-config-test-'));
	const log: string[] = [];
	const service = new DaemonService(message => log.push(message), { OUTSCALED_CONFIG_DIR: root, WSD_PORT: '0', PATH: root });
	try {
		await delay(50);
		assert.deepEqual(service.servers.map(s => s.host), ['local']);
		writeFileSync(join(root, 'servers.toml'), '[[server]]\nhost="example-alias"\n[[server]]\nhost="-bad"');
		await service.refresh();
		assert.deepEqual(service.servers.map(s => s.host), ['local', 'example-alias']);
		assert.ok(log.some(line => line.includes('server 2')));
		writeFileSync(join(root, 'servers.toml'), '[[server]');
		await service.refresh();
		assert.equal(service.servers.length, 2);
		rmSync(join(root, 'servers.toml'));
		await until(() => service.servers.length === 1); // Automatic reread, no Refresh.
	} finally { service.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('tunnel restarts after SSH failure and kills a proxy process group on disposal', async () => {
	const root = mkdtempSync(join(tmpdir(), 'outscaled-ssh-test-'));
	const bin = join(root, 'bin'); mkdirSync(bin);
	const log = join(root, 'pids');
	writeFileSync(join(bin, 'ssh'), `#!${process.execPath}\nconst {appendFileSync,existsSync}=require('node:fs');\nconst {spawn}=require('node:child_process');\nif(!existsSync(process.env.TEST_LOG)){appendFileSync(process.env.TEST_LOG,process.pid+'\\n');console.error('test failure');process.exit(255);}\nconst proxy=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});\nappendFileSync(process.env.TEST_LOG,process.pid+','+proxy.pid+'\\n');\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, { mode: 0o755 });
	const failures: string[] = [];
	const tunnel = new Tunnel('example-alias', { PATH: bin, TEST_LOG: log }, (_url, error) => { if (error) {failures.push(error);} });
	const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
	try {
		tunnel.start();
		await until(() => failures.length > 0);
		assert.match(failures[0], /test failure/);
		await until(() => readFileSync(log, 'utf8').trim().split('\n').length === 2);
		const [pid, proxy] = readFileSync(log, 'utf8').trim().split('\n')[1].split(',').map(Number);
		await delay(100);
		tunnel.dispose();
		await until(() => !alive(pid) && !alive(proxy));
	} finally { tunnel.dispose(); rmSync(root, { recursive: true, force: true }); }
});


test('pending startup requests are cancelled when their connection is disposed', async () => {
	const connection = new Connection('test', () => {}, () => {});
	const first = assert.rejects(connection.request('fs/demo/?op=stat'), /Connection stopped/);
	const second = assert.rejects(connection.request('fs/demo/file?op=read'), /Connection stopped/);
	connection.dispose();
	await Promise.all([first, second]);
});


test('latest line events apply to the matching workspace and run events refresh schedules', () => {
	const state: ServerState = { host: 'local', online: true, workspaces: [workspace], terminals: [{ ...terminal }] };
	const message = { type: 'terminal.latest_line', workspace: 'demo', terminal: terminal.id, payload: { latestLine: 'Newest assistant message' } };
	assert.equal(applyMessage(state, StreamMessage.parse(message)), false);
	assert.equal(state.terminals[0].latestLine, 'Newest assistant message');
	assert.equal(applyMessage(state, StreamMessage.parse({ ...message, workspace: 'other' })), true);
	assert.equal(applyMessage(state, StreamMessage.parse({ ...message, payload: { latestLine: null } })), false);
	assert.equal(state.terminals[0].latestLine, null);
	for (const type of ['run.started', 'run.finished']) {
		assert.equal(applyMessage(state, StreamMessage.parse({ id: 'event', type, workspace: 'demo', terminal: terminal.id, payload: {}, time, acked: false })), true);
	}
	assert.throws(() => applyMessage(state, { ...message, payload: { latestLine: 'invalid\nline' } } as StreamMessage));
});


test('late permission data updates the request without moving its waiting age; working clears it', () => {
	const state: ServerState = { host: 'local', online: true, workspaces: [workspace], terminals: [{ ...terminal }] };
	const first = status('needs_input');
	applyMessage(state, first);
	const request = { message: 'Permission required', permission: { question: 'Do you want to proceed?', options: [{ number: 1, label: 'Yes' }, { number: 4, label: 'No' }] } };
	applyMessage(state, { ...status('needs_input', '2026-01-01T00:00:02.000Z'), payload: { newStatus: 'needs_input', request } });
	assert.deepEqual({ request: state.terminals[0].request, time: state.terminals[0].statusChangedAt }, { request, time: '2026-01-01T00:00:01.000Z' });
	applyMessage(state, status('working', '2026-01-01T00:00:03.000Z'));
	assert.deepEqual({ request: state.terminals[0].request, time: state.terminals[0].statusChangedAt }, { request: null, time: '2026-01-01T00:00:03.000Z' });
	assert.throws(() => applyMessage(state, { ...first, payload: { newStatus: 'needs_input', request: { permission: 1 } } }));
});
