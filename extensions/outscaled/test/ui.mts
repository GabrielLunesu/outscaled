/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Hermetic sidebar acceptance check. From the repo root:
//   cd daemon && ../scripts/serial.sh bun run build
//   scripts/serial.sh node extensions/outscaled/test/ui.mts
// Builds must already be current. No real daemon, SSH target or user config is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'package.json'));
const { _electron } = require('playwright-core');
const product = require(join(root, 'product.json'));
const evidence = resolve(process.argv[2] ?? join(root, '.agent-validation/sidebar'));
mkdirSync(evidence, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'outscaled-ui-'));
const bin = join(temporary, 'bin'); mkdirSync(bin);
const config = join(temporary, 'client-config'); mkdirSync(config);
const sshLog = join(temporary, 'ssh.jsonl');
const daemons: { process?: ChildProcess; port: number; env: NodeJS.ProcessEnv }[] = [];
let app: any;
let win: any;
async function until(check: () => Promise<boolean> | boolean, message: string, timeout = 30000) {
	const deadline = Date.now() + timeout;
	while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${message}`); await delay(100); }
}
async function port() {
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const value = (server.address() as { port: number }).port;
	await new Promise<void>(resolve => server.close(() => resolve()));
	assert.notEqual(value, 7770);
	return value;
}
async function request(index: number, path: string, body?: unknown) {
	const response = await fetch(`http://127.0.0.1:${daemons[index].port}/v1/${path}`, {
		method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000)
	});
	assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`);
	return response.status === 204 ? undefined : response.json();
}
async function start(index: number) {
	const daemon = daemons[index];
	const child = spawn(join(root, 'daemon/dist/wsd'), [], { env: daemon.env, stdio: ['ignore', 'pipe', 'pipe'] });
	daemon.process = child;
	let log = '';
	child.stdout!.on('data', data => { log += data; }); child.stderr!.on('data', data => { log += data; });
	await until(async () => {
		if (child.exitCode !== null) throw new Error(`Daemon exited: ${log}`);
		try { await request(index, 'health'); return true; } catch { return false; }
	}, 'daemon health');
}
async function stop(index: number) {
	const child = daemons[index].process;
	if (!child || child.exitCode !== null) return;
	child.kill('SIGTERM');
	await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
	if (child.exitCode === null) child.kill('SIGKILL');
}
async function capture(name: string) {
	const text = await win.locator('.sidebar').innerText();
	const rows = await win.locator('.sidebar [role="treeitem"]').evaluateAll((items: Element[]) => items.map(item => ({
		text: (item as HTMLElement).innerText,
		label: item.getAttribute('aria-label'),
		icons: Array.from(item.querySelectorAll('.codicon')).map(icon => ({ class: icon.className, style: icon.getAttribute('style') }))
	})));
	console.log(name, JSON.stringify({ text, rows }));
	writeFileSync(join(evidence, `${name}.json`), JSON.stringify({ text, rows }, null, 2));
	await win.screenshot({ path: join(evidence, `${name}.png`) });
}
const row = (name: string) => win.locator('.sidebar .monaco-list-row').filter({ hasText: name });

try {
	writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexec /bin/sleep 3600\n', { mode: 0o755 });
	writeFileSync(join(bin, 'ssh'), `#!${process.execPath}
const {appendFileSync}=require('node:fs');
const {connect,createServer}=require('node:net');
const args=process.argv.slice(2), forward=args[args.indexOf('-L')+1];
if(args.at(-1)!=='example-alias'||!/^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:7770$/.test(forward))process.exit(255);
appendFileSync(process.env.TEST_SSH_LOG,JSON.stringify({pid:process.pid,args})+'\\n');
createServer(socket=>{const remote=connect({host:'127.0.0.1',port:Number(process.env.TEST_REMOTE_PORT)});socket.pipe(remote).pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());}).listen(Number(forward.split(':')[1]),'127.0.0.1');
`, { mode: 0o755 });
	writeFileSync(join(config, 'servers.toml'), '[[server]]\nhost = "example-alias"\n');
	for (const name of ['mac', 'vps']) {
		const directory = join(temporary, name); mkdirSync(directory);
		const configDir = join(directory, 'config'); mkdirSync(configDir);
		writeFileSync(join(configDir, 'config.toml'), `name = "test-${name}"\n`);
		daemons.push({ port: await port(), env: { ...process.env, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}`,
			WSD_CONFIG_DIR: configDir, WSD_STATE_DIR: join(directory, 'state'), WSD_WORKSPACES_DIR: join(directory, 'workspaces'),
			WSD_TMUX_SOCKET: join(directory, 'tmux.sock') } });
		daemons.at(-1)!.env.WSD_PORT = String(daemons.at(-1)!.port);
	}
	for (const index of [0, 1]) {
		await start(index);
		const slug = index === 0 ? 'mac-demo' : 'vps-demo';
		await request(index, 'workspaces', { slug });
		const agent = await request(index, `workspaces/${slug}/terminals`, { name: `${index === 0 ? 'mac' : 'vps'}-agent`, command: join(bin, 'claude') });
		assert.equal(agent.runtime, 'claude-code');
		await request(index, 'hooks/claude-code', { terminal: agent.id, payload: { hook_event_name: 'Stop' } });
		await request(index, `workspaces/${slug}/terminals`, { name: `${index === 0 ? 'mac' : 'vps'}-shell` });
	}
	const profile = join(temporary, 'profile');
	mkdirSync(join(profile, 'data/User'), { recursive: true });
	writeFileSync(join(profile, 'data/User/settings.json'), JSON.stringify({ 'window.title': 'Outscaled sidebar acceptance', 'workbench.startupEditor': 'none', 'files.simpleDialog.enable': true }));
	const env = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1',
		WSD_PORT: String(daemons[0].port), OUTSCALED_CONFIG_DIR: config, PATH: `${bin}:${process.env.PATH}`,
		TEST_REMOTE_PORT: String(daemons[1].port), TEST_SSH_LOG: sshLog };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.GIT_CONFIG_COUNT;
	delete env.GIT_CONFIG_PARAMETERS;
	app = await _electron.launch({
		executablePath: join(root, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort),
		args: [root, join(temporary, 'mac/workspaces/mac-demo'), '--user-data-dir', join(profile, 'data'),
			'--shared-data-dir', join(profile, 'shared'), '--extensions-dir', join(profile, 'ext'),
			'--skip-release-notes', '--skip-welcome', '--disable-workspace-trust', '--disable-telemetry',
			'--disable-updates', '--disable-extension=vscode.vscode-api-tests'], env, timeout: 120000
	});
	win = await app.firstWindow();
	await win.waitForSelector('.monaco-workbench', { timeout: 120000 });
	await win.locator('.activitybar .action-item a[aria-label^="Outscaled"]').click();
	await until(async () => (await win.locator('.sidebar').innerText()).includes('vps-agent'), 'both servers and their terminals');
	assert.ok((await win.locator('.sidebar').innerText()).includes('mac-shell'));
	await capture('01-initial');
	const agent = (await request(0, 'terminals')).find((t: any) => t.name === 'mac-agent');
	await request(0, 'hooks/claude-code', { terminal: agent.id, payload: { hook_event_name: 'UserPromptSubmit' } });
	await until(async () => await row('mac-agent').locator('.codicon-loading').count() === 1, 'working spinner');
	await capture('02-working');
	await request(0, 'hooks/claude-code', { terminal: agent.id, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } });
	await until(async () => (await row('mac-demo').innerText()).includes('1 need you'), 'workspace needs-you badge');
	assert.equal(await row('mac-agent').locator('.codicon-circle-filled').count(), 1);
	await capture('03-needs-input');
	process.kill(agent.pid, 'SIGKILL');
	await until(async () => /exited|crashed/.test(await row('mac-agent').innerText()), 'terminal exit');
	assert.ok(!(await row('mac-demo').innerText()).includes('need you'));
	await capture('04-exited');
	await stop(1);
	await until(async () => (await row('example-alias').innerText()).includes('offline'), 'remote offline');
	await capture('05-remote-offline');
	await start(1);
	await until(async () => (await row('example-alias').innerText()).includes('online'), 'remote recovery');
	assert.ok((await win.locator('.sidebar').innerText()).includes('vps-shell'));
	await capture('06-recovered');
	// All client SSH calls are to the fake, and the long-lived tunnel is reused.
	const invocations = readFileSync(sshLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
	assert.equal(invocations.length, 1);
	assert.equal(invocations[0].args.at(-1), 'example-alias');
	console.log('PASS: live sidebar, hooks, badges, terminal exit, offline/recovery and single tunnel');
	const logs: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/exthost|extensionHost/i.test(path)) {
				for (const line of readFileSync(path, 'utf8').split('\n')) if (/outscaled/i.test(line) && /error|warn/i.test(line)) logs.push(line);
			}
		}
	};
	walk(join(profile, 'data/logs'));
	assert.deepEqual(logs, []);
	await app.close(); app = undefined;
	await until(() => { try { process.kill(invocations[0].pid, 0); return false; } catch { return true; } }, 'extension tunnel cleanup');
} finally {
	if (app) {
		try { if (win) await capture('failure'); } catch {}
		await app.close().catch(() => {});
	}
	for (const index of [0, 1]) if (daemons[index]) {
		await stop(index);
		spawnSync('tmux', ['-S', daemons[index].env.WSD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' });
	}
	try {
		for (const line of readFileSync(sshLog, 'utf8').trim().split('\n')) {
			try { process.kill(-JSON.parse(line).pid, 'SIGKILL'); } catch {}
		}
	} catch {}
	rmSync(temporary, { recursive: true, force: true });
}
