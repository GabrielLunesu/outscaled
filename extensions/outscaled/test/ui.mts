/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Hermetic sidebar and workspace-switch acceptance check. From the repo root:
//   cd daemon && ../scripts/serial.sh bun run build
//   scripts/serial.sh node extensions/outscaled/test/ui.mts
// Builds must already be current. No real daemon, SSH target or user config is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'package.json'));
const { _electron } = require('playwright-core');
const product = require(join(root, 'product.json'));
const evidence = resolve(process.argv[2] ?? join(root, '.agent-validation/switch'));
mkdirSync(evidence, { recursive: true });
if (process.env.UI_INSPECT_LAUNCH) rmSync(join(evidence, 'launch-inspected'), { force: true });
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
	console.log(`${name}: ${text.replaceAll('\n', ' | ')}`);
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
		const folder = join(temporary, index === 0 ? 'registered-local' : 'vps/workspaces/vps-demo');
		if (index === 0) mkdirSync(folder);
		await request(index, 'workspaces', index === 0 ? { slug, path: folder } : { slug });
		mkdirSync(join(folder, 'src/nested'), { recursive: true });
		writeFileSync(join(folder, 'src/nested/hello.txt'), index === 0 ? 'local file\n' : 'remote file\n');
		writeFileSync(join(folder, 'README.md'), 'workspace fixture\n');
		const agent = await request(index, `workspaces/${slug}/terminals`, { name: `${index === 0 ? 'mac' : 'vps'}-agent`, command: join(bin, 'claude') });
		assert.equal(agent.runtime, 'claude-code');
		await request(index, 'hooks/claude-code', { terminal: agent.id, payload: { hook_event_name: 'Stop' } });
		await request(index, `workspaces/${slug}/terminals`, { name: `${index === 0 ? 'mac' : 'vps'}-shell` });
	}
	const profile = join(temporary, 'profile');
	mkdirSync(join(profile, 'data/User'), { recursive: true });
	writeFileSync(join(profile, 'data/User/settings.json'), JSON.stringify({ 'window.title': 'Outscaled sidebar acceptance', 'workbench.startupEditor': 'none', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'window.confirmSaveUntitledWorkspace': false, 'files.simpleDialog.enable': true }));
	const env = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1',
		WSD_PORT: String(daemons[0].port), OUTSCALED_CONFIG_DIR: config, PATH: `${bin}:${process.env.PATH}`,
		TEST_REMOTE_PORT: String(daemons[1].port), TEST_SSH_LOG: sshLog };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.GIT_CONFIG_COUNT;
	delete env.GIT_CONFIG_PARAMETERS;
	app = await _electron.launch({
		executablePath: join(root, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort),
		args: [root, join(temporary, 'registered-local'), '--user-data-dir', join(profile, 'data'),
			'--shared-data-dir', join(profile, 'shared'), '--extensions-dir', join(profile, 'ext'),
			'--skip-release-notes', '--skip-welcome', '--disable-workspace-trust', '--disable-telemetry',
			'--disable-updates', '--disable-extension=vscode.vscode-api-tests', '--disable-extension=vscode.json-language-features'], env, timeout: 120000
	});
	win = await app.firstWindow();
	await win.waitForSelector('.monaco-workbench', { timeout: 120000 });
	await win.screenshot({ path: join(evidence, '00-launched.png') });
	// Optional review gate lets the caller inspect the real launch before interaction.
	if (process.env.UI_INSPECT_LAUNCH) await until(() => existsSync(join(evidence, 'launch-inspected')), 'visual launch inspection', 60000);
	await win.locator('.activitybar .action-item a[aria-label^="Outscaled"]').click();
	await until(async () => (await win.locator('.sidebar').innerText()).includes('vps-agent'), 'both servers and their terminals');
	assert.ok((await win.locator('.sidebar').innerText()).includes('mac-shell'));
	await capture('01-initial');
	const outscaled = async () => {
		if (await win.locator('.sidebar').isVisible() && (await win.locator('.sidebar').innerText()).includes('Outscaled: Workspaces')) return;
		await win.keyboard.press('F1');
		await win.locator('.quick-input-widget input').fill('>Focus on Workspaces View');
		await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Focus on Workspaces View' }).first().waitFor();
		await win.keyboard.press('Enter');
		await until(async () => await win.locator('.sidebar').isVisible() && (await win.locator('.sidebar').innerText()).includes('vps-demo'), 'workspace sidebar');
	};
	const explorer = async () => {
		if (await win.locator('.sidebar').isVisible() && (await win.locator('.sidebar').innerText()).startsWith('Explorer')) return;
		await win.locator('.activitybar .action-item a[aria-label^="Explorer"]').click();
	};
	const selected = async (slug: string) => {
		await until(async () => (await row(slug).innerText()).includes('selected'), `selected ${slug}`);
	};
	// First entry is allowed to reload, moving to a persistent multi-root workspace.
	await row('vps-demo').locator('.label-name').click();
	await until(() => existsSync(join(config, 'outscaled.code-workspace')), 'dedicated workspace created');
	await until(async () => {
		try { return (await win.title()).includes('Outscaled'); } catch { return false; }
	}, 'window ready');
	await delay(3000);
	await outscaled();
	await selected('vps-demo');
	const workspaceDocument = JSON.parse(readFileSync(join(config, 'outscaled.code-workspace'), 'utf8'));
	assert.equal(workspaceDocument.folders[0].uri, 'ws://outscaled/');
	assert.equal(workspaceDocument.folders[1].uri, 'ws://example-alias/vps-demo/');
	const sentinel = `switch-${Date.now()}`;
	await win.evaluate((value: string) => { (window as any).__outscaledSwitchSentinel = value; }, sentinel);
	const extensionPids = () => {
		const pids: string[] = [];
		const scan = (directory: string) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) scan(path);
				else if (entry.name === 'exthost.log') {
					for (const match of readFileSync(path, 'utf8').matchAll(/Extension host with pid (\d+) started/g)) pids.push(match[1]);
				}
			}
		};
		scan(join(profile, 'data/logs'));
		assert.ok(pids.length > 0, 'extension host startup PID is logged');
		return pids;
	};
	const hostsBeforeSwitch = extensionPids();
	const sshBeforeSwitch = readFileSync(sshLog, 'utf8').trim().split('\n').length;
	await explorer();
	await until(async () => (await win.locator('.sidebar').innerText()).includes('vps-demo'), 'remote explorer root');
	await row('vps-demo').dblclick();
	await row('src').dblclick();
	// Compact folders can combine src/nested into a single row.
	if (await row('nested').count() && !(await row('hello.txt').count())) await row('nested').dblclick();
	await until(async () => await row('hello.txt').count() === 1, 'remote nested file');
	await row('hello.txt').dblclick();
	await win.locator('.editor-instance .view-lines').filter({ hasText: 'remote file' }).waitFor();
	await capture('07-remote-open');
	await win.locator('.editor-instance .view-lines').click();
	await win.keyboard.press('Meta+End');
	// A synthetic paste works with Monaco's native edit context without using the system clipboard.
	await win.evaluate(() => {
		const target = document.activeElement!;
		const data = new DataTransfer(); data.setData('text/plain', 'saved through wsd\n');
		target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	});
	await win.keyboard.press('Meta+s');
	await until(() => readFileSync(join(temporary, 'vps/workspaces/vps-demo/src/nested/hello.txt'), 'utf8').includes('saved through wsd'), 'remote save landed on daemon disk');
	await capture('08-remote-saved');
	await outscaled();
	await row('mac-demo').locator('.label-name').click();
	await selected('mac-demo');
	await until(async () => await win.locator('.tabs-container .tab').filter({ hasText: 'hello.txt' }).count() === 0, 'remote editor closed on local switch');
	await explorer();
	await until(async () => (await win.locator('.sidebar').innerText()).includes('mac-demo'), 'local explorer root');
	await row('mac-demo').dblclick();
	await until(async () => (await win.locator('.sidebar').innerText()).includes('README.md'), 'local files');
	const localDocument = JSON.parse(readFileSync(join(config, 'outscaled.code-workspace'), 'utf8'));
	const localFolder = localDocument.folders[1];
	assert.equal(localFolder.uri ?? `file://${resolve(config, localFolder.path)}`, `file://${join(temporary, 'registered-local')}`);
	await capture('09-local');
	await outscaled();
	await row('vps-demo').locator('.label-name').click();
	await selected('vps-demo');
	await until(async () => await win.locator('.tabs-container .tab').filter({ hasText: 'hello.txt' }).count() === 1, 'remote editor restored');
	await explorer();
	await until(async () => (await win.locator('.sidebar').innerText()).includes('vps-demo'), 'restored remote explorer root');
	await capture('10-remote-restored');
	// An unsaved remote editor must survive switching away, without an implicit save.
	await win.locator('.editor-instance .view-lines').click();
	await win.evaluate(() => {
		const data = new DataTransfer(); data.setData('text/plain', 'unsaved edit');
		document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	});
	await until(async () => await win.locator('.tabs-container .tab.dirty').count() > 0, 'dirty remote editor');
	await outscaled();
	await row('mac-demo').locator('.label-name').click();
	await selected('mac-demo');
	assert.equal(await win.locator('.tabs-container .tab.dirty').filter({ hasText: 'hello.txt' }).count(), 1);
	assert.ok(!readFileSync(join(temporary, 'vps/workspaces/vps-demo/src/nested/hello.txt'), 'utf8').includes('unsaved edit'));
	await capture('11-dirty-kept');
	await row('vps-demo').locator('.label-name').click();
	await selected('vps-demo');
	assert.equal(await win.locator('.tabs-container .tab').filter({ hasText: 'hello.txt' }).count(), 1, 'dirty editor is not duplicated');
	await win.keyboard.press('Meta+s');
	await until(() => readFileSync(join(temporary, 'vps/workspaces/vps-demo/src/nested/hello.txt'), 'utf8').includes('unsaved edit'), 'explicit save of retained editor');
	assert.equal(await win.evaluate(() => (window as any).__outscaledSwitchSentinel), sentinel, 'renderer survived switches');
	assert.deepEqual(extensionPids(), hostsBeforeSwitch, 'extension host was not restarted');
	assert.equal(readFileSync(sshLog, 'utf8').trim().split('\n').length, sshBeforeSwitch, 'tunnel survived switches');
	writeFileSync(join(evidence, 'switch-proof.json'), JSON.stringify({ sentinel, extensionHostPids: hostsBeforeSwitch,
		sshInvocationsAfterEntry: sshBeforeSwitch, remoteContents: readFileSync(join(temporary, 'vps/workspaces/vps-demo/src/nested/hello.txt'), 'utf8'), workspaceDocument }, null, 2));
	console.log('PASS: remote explorer/read/save, native local root, editor memory, dirty editor retention, renderer and extension-host survival');
	// Deliberately reload only after proving that switching itself never did.
	await win.keyboard.press('F1');
	await win.locator('.quick-input-widget input').fill('>Developer: Reload Window');
	await win.keyboard.press('Enter');
	await until(async () => {
		try { return await win.evaluate(() => (window as any).__outscaledSwitchSentinel === undefined); } catch { return false; }
	}, 'deliberate reload');
	// Wait for the restored view before sending keys: the new renderer can exist
	// before it has installed keyboard handlers.
	await row('vps-demo').waitFor({ state: 'visible' });
	await selected('vps-demo');
	await win.locator('.editor-instance .view-lines').filter({ hasText: 'unsaved edit' }).waitFor();
	await capture('12-selection-after-reload');
	assert.equal(extensionPids().length, hostsBeforeSwitch.length + 1, 'one extension restart for deliberate reload');
	console.log('PASS: selection persisted across deliberate reload');
	await outscaled();
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
	assert.equal(invocations.length, sshBeforeSwitch + 1); // Initial entry and deliberate reload may restart extensions.
	assert.equal(invocations[0].args.at(-1), 'example-alias');
	console.log('PASS: live sidebar, hooks, badges, terminal exit, offline/recovery and single tunnel');
	const logs: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/exthost|extensionHost/i.test(path)) {
				for (const line of readFileSync(path, 'utf8').split('\n')) if (/vscode\.outscaled|extensions[/\\]outscaled|Outscaled:/i.test(line) && /error|warn/i.test(line)) logs.push(line);
			}
		}
	};
	walk(join(profile, 'data/logs'));
	assert.deepEqual(logs, []);
	await app.close(); app = undefined;
	await until(() => invocations.every(invocation => { try { process.kill(invocation.pid, 0); return false; } catch { return true; } }), 'extension tunnel cleanup');
} finally {
	if (app) {
		const copyLogs = (directory: string, prefix = '') => {
			if (!existsSync(directory)) return;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) copyLogs(path, prefix + entry.name + '-');
				else if (entry.name.endsWith('.log')) writeFileSync(join(evidence, prefix + entry.name), readFileSync(path));
			}
		};
		copyLogs(join(temporary, 'profile/data/logs'));
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
