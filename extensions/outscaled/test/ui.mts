/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Hermetic sidebar, workspace-switch, terminal-grid and notification acceptance check. From the repo root:
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'package.json'));
const { _electron } = require('playwright-core');
const product = require(join(root, 'product.json'));
const evidence = resolve(process.argv[2] ?? join(root, '.agent-validation/grid'));
mkdirSync(evidence, { recursive: true });
if (process.env.UI_INSPECT_LAUNCH) rmSync(join(evidence, 'launch-inspected'), { force: true });
const temporary = mkdtempSync(join(tmpdir(), 'outscaled-ui-'));
const bin = join(temporary, 'bin'); mkdirSync(bin);
const config = join(temporary, 'client-config'); mkdirSync(config);
const sshLog = join(temporary, 'ssh.jsonl');
const notificationLog = join(evidence, 'notification-requests.jsonl');
const notificationControl = join(temporary, 'notification-control.json');
const notificationReady = join(temporary, 'notification-ready');
writeFileSync(notificationLog, '');
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
	for (const agent of ['claude', 'codex']) writeFileSync(join(bin, agent), `#!/bin/sh\necho 'fake ${agent} ready'\nexec /bin/sleep 3600\n`, { mode: 0o755 });
	writeFileSync(join(bin, 'ssh'), `#!${process.execPath}
const {appendFileSync}=require('node:fs');
const {connect,createServer}=require('node:net');
const args=process.argv.slice(2), forward=args[args.indexOf('-L')+1];
const record=kind=>appendFileSync(process.env.TEST_SSH_LOG,JSON.stringify({pid:process.pid,args,kind})+'\\n');
if(args[0]==='-t'&&args[1]==='example-alias'){
 const command=args.slice(2).map(arg=>arg.replace(/^'|'$/g,''));
 if(JSON.stringify(command.slice(0,-1))!==JSON.stringify(['sudo','-n','-u','ws','-H','tmux','-u','attach-session','-t'])||!/^=ws-vps-demo-[a-z0-9-]+$/.test(command.at(-1)))process.exit(255);
 record('attach');
 const child=require('node:child_process').spawn('tmux',['-u','-S',process.env.TEST_REMOTE_TMUX_SOCKET,'attach-session','-t',command.at(-1)],{stdio:'inherit'});
 for(const signal of ['SIGTERM','SIGHUP','SIGINT'])process.on(signal,()=>child.kill(signal));
 child.on('exit',code=>process.exit(code??1));
}else{
 if(args.at(-1)!=='example-alias'||!args.includes('-L'))process.exit(255);
 const tcp=/^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:7770$/.test(forward);
 const unix=forward.endsWith(':127.0.0.1:'+process.env.WSD_PORT)&&forward.startsWith(require('node:os').tmpdir()+'/ws-');
 if(!tcp&&!unix)process.exit(255);
 record(tcp?'extension-tunnel':'cli-tunnel');
 const server=createServer(socket=>{const remote=connect({host:'127.0.0.1',port:Number(process.env.TEST_REMOTE_PORT)});socket.pipe(remote).pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());});
 if(tcp)server.listen(Number(forward.split(':')[1]),'127.0.0.1');else server.listen(forward.slice(0,forward.lastIndexOf(':127.0.0.1:')));
}
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
	// Only this throwaway test extension intercepts native toasts. Production
	// contains no click simulation, logging hook or test command.
	const notificationProbe = join(temporary, 'notification-probe'); mkdirSync(notificationProbe);
	writeFileSync(join(notificationProbe, 'package.json'), JSON.stringify({ name: 'outscaled-notification-probe', publisher: 'test',
		version: '0.0.1', engines: { vscode: '^1.143.0' }, main: './extension.cjs', activationEvents: ['*'] }));
	writeFileSync(notificationControl, '{}');
	writeFileSync(join(notificationProbe, 'extension.cjs'), `
const vscode = require('vscode');
const fs = require('node:fs');
exports.activate = context => {
  const read = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(notificationControl)}, 'utf8')); } catch { return {}; } };
  context.subscriptions.push(vscode.commands.registerCommand('_outscaled.notify', request => {
    fs.appendFileSync(${JSON.stringify(notificationLog)}, JSON.stringify(request) + '\\n');
    if (read().hold !== request.id) return { shown: false, clicked: false };
    return new Promise(resolve => {
      const timer = setInterval(() => {
        if (read().click === request.id) { clearInterval(timer); resolve({ shown: true, clicked: true }); }
      }, 50);
      context.subscriptions.push({ dispose: () => { clearInterval(timer); resolve({ shown: false, clicked: false }); } });
    });
  }));
  fs.writeFileSync(${JSON.stringify(notificationReady)}, 'ready');
};
`);
	mkdirSync(join(profile, 'data/User'), { recursive: true });
	writeFileSync(join(profile, 'data/User/settings.json'), JSON.stringify({ 'window.title': 'Outscaled sidebar acceptance', 'workbench.startupEditor': 'none', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'window.confirmSaveUntitledWorkspace': false, 'files.simpleDialog.enable': true, 'outscaled.wsPath': join(root, 'daemon/dist/ws'), 'editor.accessibilitySupport': 'on', 'explorer.compactFolders': false }));
	const env = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1',
		WSD_PORT: String(daemons[0].port), WSD_TMUX_SOCKET: daemons[0].env.WSD_TMUX_SOCKET, OUTSCALED_CONFIG_DIR: config, PATH: `${bin}:${process.env.PATH}`,
		TEST_REMOTE_PORT: String(daemons[1].port), TEST_REMOTE_TMUX_SOCKET: daemons[1].env.WSD_TMUX_SOCKET, TEST_SSH_LOG: sshLog };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.GIT_CONFIG_COUNT;
	delete env.GIT_CONFIG_PARAMETERS;
	app = await _electron.launch({
		executablePath: join(root, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort),
		args: [root, join(temporary, 'registered-local'), '--user-data-dir', join(profile, 'data'),
			'--extensionDevelopmentPath', notificationProbe,
			'--shared-data-dir', join(profile, 'shared'), '--extensions-dir', join(profile, 'ext'),
			'--skip-release-notes', '--skip-welcome', '--disable-workspace-trust', '--disable-telemetry',
			'--disable-updates', '--disable-extension=vscode.vscode-api-tests', '--disable-extension=vscode.json-language-features'], env, timeout: 120000
	});
	// Observe native dialogs rather than relying on DOM visibility. Only explicit
	// user-close tests may confirm termination. A switch that asks is a failure;
	// cancel it so a regression cannot strand a native modal during cleanup.
	await app.evaluate(({ dialog }: any) => {
		const state = { allowUserClose: false, confirmations: [] as { message: string; expected: boolean }[] };
		(globalThis as any).__outscaledDialogs = state;
		const original = dialog.showMessageBox.bind(dialog);
		dialog.showMessageBox = (...args: any[]) => {
			const options = args.find(arg => arg && typeof arg.message === 'string');
			if (!/terminate running processes/i.test(options?.message ?? '')) return original(...args);
			state.confirmations.push({ message: options.message, expected: state.allowUserClose });
			const terminate = options.buttons.findIndex((button: string) => /terminate/i.test(button));
			return Promise.resolve({ response: state.allowUserClose ? terminate : options.cancelId, checkboxChecked: false });
		};
	});
	win = await app.firstWindow();
	win.setDefaultTimeout(30000);
	await win.waitForSelector('.monaco-workbench', { timeout: 120000 });
	await win.screenshot({ path: join(evidence, '00-launched.png') });
	// Optional review gate lets the caller inspect the real launch before interaction.
	if (process.env.UI_INSPECT_LAUNCH) await until(() => existsSync(join(evidence, 'launch-inspected')), 'visual launch inspection', 60000);
	await until(() => existsSync(notificationReady), 'notification probe activated');
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
	if (await row('vps-demo').locator('.monaco-tl-twistie.collapsed').count()) await row('vps-demo').locator('.monaco-tl-twistie').click();
	await row('src').locator('.monaco-tl-twistie').click();
	await row('nested').waitFor();
	await row('nested').locator('.monaco-tl-twistie').click();
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
	if (await row('mac-demo').locator('.monaco-tl-twistie.collapsed').count()) await row('mac-demo').locator('.monaco-tl-twistie').click();
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
	// Real native editor terminals must attach through the built ws CLI.
	await outscaled();
	await row('mac-demo').locator('.label-name').click();
	await selected('mac-demo');
	const command = async (title: string) => {
		await win.keyboard.press('F1');
		await win.locator('.quick-input-widget input').fill(`>${title}`);
		await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: title }).first().waitFor();
		await win.keyboard.press('Enter');
	};
	// Test-only renderer probe. Read the actual child-process monitor and effective
	// setting from workbench services; no production hooks or settings overrides.
	const installTerminalProbe = async () => {
		await win.evaluate(async (base: string) => {
			const { CommandsRegistry } = await import(base + 'vs/platform/commands/common/commands.js');
			const { MenuRegistry, MenuId } = await import(base + 'vs/platform/actions/common/actions.js');
			const { ITerminalService } = await import(base + 'vs/workbench/contrib/terminal/browser/terminal.js');
			const { IConfigurationService } = await import(base + 'vs/platform/configuration/common/configuration.js');
			const id = 'outscaled.test.inspectAttachClients';
			CommandsRegistry.registerCommand(id, (accessor: any) => {
				(window as any).__outscaledTerminalProbe = { service: accessor.get(ITerminalService), configuration: accessor.get(IConfigurationService) };
			});
			MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id, title: 'Outscaled Test: Inspect Attach Clients' } });
		}, pathToFileURL(join(root, 'out/')).href.replace('file://', 'vscode-file://vscode-app'));
		await command('Outscaled Test: Inspect Attach Clients');
	};
	const childProof: unknown[] = [];
	const proveAttachChildren = async () => {
		let snapshot: any;
		await until(async () => {
			snapshot = await win.evaluate(() => {
				const probe = (window as any).__outscaledTerminalProbe;
				return { confirmOnKill: probe.configuration.getValue('terminal.integrated.confirmOnKill'),
					defaultConfirmOnKill: probe.configuration.inspect('terminal.integrated.confirmOnKill').defaultValue,
					panes: probe.service.instances.map((terminal: any) => ({ name: terminal.title, processId: terminal.processId, hasChildProcesses: terminal.hasChildProcesses })) };
			});
			return snapshot.panes.length > 0 && snapshot.panes.every((pane: any) => pane.processId && pane.hasChildProcesses);
		}, 'VS Code child-process detection for every attach client');
		assert.equal(snapshot.confirmOnKill, 'editor');
		assert.equal(snapshot.confirmOnKill, snapshot.defaultConfirmOnKill, 'use the default confirmOnKill setting');
		const processes = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
		assert.equal(processes.status, 0);
		const parents = processes.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
		for (const pane of snapshot.panes) {
			pane.childPids = parents.filter(([, parent]) => parent === pane.processId).map(([pid]) => pid);
			assert.ok(pane.childPids.length > 0, `${pane.name}: attach client still has a live child before switching`);
		}
		childProof.push(snapshot);
		writeFileSync(join(evidence, 'detach-children-proof.json'), JSON.stringify(childProof, null, 2));
	};
	const confirmations = () => app.evaluate(() => (globalThis as any).__outscaledDialogs.confirmations);
	const assertNoUnexpectedConfirmations = async () => assert.deepEqual((await confirmations()).filter((entry: any) => !entry.expected), [], 'no native termination confirmation during grid detach');
	const allowUserClose = (allowed: boolean) => app.evaluate((_: any, value: boolean) => { (globalThis as any).__outscaledDialogs.allowUserClose = value; }, allowed);
	await installTerminalProbe();
	await command('View: Close All Editors');
	const openGrid = async (label = '2 Claude + 2 Codex') => {
		await command('Outscaled: Open Grid');
		await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: label }).click();
	};
	const gridProof = () => win.locator('.editor-group-container').evaluateAll((groups: Element[]) => groups.map(group => {
		const bounds = group.getBoundingClientRect();
		return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
			tabs: Array.from(group.querySelectorAll('.tabs-container .tab')).map(tab => ({
				name: tab.querySelector('.label-name')?.textContent, label: tab.getAttribute('aria-label'),
				icons: Array.from(tab.querySelectorAll('.codicon, .monaco-icon-label')).map(icon => ({
					class: icon.className, color: getComputedStyle(icon).color, beforeColor: getComputedStyle(icon, '::before').color
				})) })), text: (group.querySelector('.xterm-accessibility-tree') as HTMLElement | null)?.innerText ?? '' };
	}));
	await openGrid();
	await until(async () => {
		const groups = await gridProof();
		return groups.length === 4 && groups.every((group: any) => group.tabs.length === 1 && /fake (claude|codex) ready/.test(group.text));
	}, 'four attached panes with fake agent output');
	const groups = (await gridProof()).sort((a: any, b: any) => a.y - b.y || a.x - b.x);
	assert.deepEqual(groups.map((group: any) => group.tabs[0].name), ['claude-1', 'claude-2', 'codex-1', 'codex-2']);
	assert.equal(groups[0].y, groups[1].y); assert.equal(groups[2].y, groups[3].y);
	assert.equal(groups[0].x, groups[2].x); assert.equal(groups[1].x, groups[3].x);
	assert.ok(groups[1].x > groups[0].x && groups[2].y > groups[0].y);
	assert.ok(groups.every((group: any) => Math.abs(group.width - groups[0].width) <= 2 && Math.abs(group.height - groups[0].height) <= 2));
	const names = ['claude-1', 'claude-2', 'codex-1', 'codex-2'];
	const gridTerminals = (await request(0, 'workspaces/mac-demo/terminals')).filter((terminal: any) => names.includes(terminal.name));
	assert.equal(gridTerminals.length, 4);
	const sessions = spawnSync('tmux', ['-S', daemons[0].env.WSD_TMUX_SOCKET!, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
	assert.equal(sessions.status, 0);
	for (const terminal of gridTerminals) { assert.equal(terminal.state, 'running'); assert.ok(sessions.stdout.split('\n').includes(terminal.session)); }
	writeFileSync(join(evidence, 'grid-proof.json'), JSON.stringify({ groups, terminals: gridTerminals.map(({ id, name, session }: any) => ({ id, name, session })), sessions: sessions.stdout }, null, 2));
	await capture('13-grid-attached');
	const claude = gridTerminals.find((terminal: any) => terminal.name === 'claude-1');
	const tab = win.locator('.tabs-container .tab').filter({ hasText: 'claude-1' });
	await request(0, 'hooks/claude-code', { terminal: claude.id, payload: { hook_event_name: 'Stop' } });
	await until(async () => await tab.locator('.codicon-circle-filled').count() > 0, 'idle tab dot');
	await capture('13b-grid-idle');
	await request(0, 'hooks/claude-code', { terminal: claude.id, payload: { hook_event_name: 'UserPromptSubmit' } });
	await until(async () => await tab.locator('[class*="codicon-loading~spin"]').count() > 0, 'live working tab spinner');
	await until(async () => (await request(0, 'workspaces/mac-demo/terminals')).find((terminal: any) => terminal.id === claude.id)?.status === 'working', 'prompt hook status');
	const working = await gridProof();
	assert.ok(working.some((group: any) => group.tabs.some((tab: any) => tab.name === 'claude-1' && tab.icons.some((icon: any) => icon.color === 'rgb(13, 188, 121)' || icon.beforeColor === 'rgb(13, 188, 121)'))), 'working tab is green');
	await capture('14-grid-working');
	await request(0, 'hooks/claude-code', { terminal: claude.id, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } });
	await until(async () => await tab.locator('.codicon-circle-filled').count() > 0, 'live needs-input tab dot');
	const needsInput = await gridProof();
	assert.ok(needsInput.some((group: any) => group.tabs.some((tab: any) => tab.name === 'claude-1' && tab.icons.some((icon: any) => icon.color === 'rgb(205, 49, 49)' || icon.beforeColor === 'rgb(205, 49, 49)'))), 'needs-input tab is red');
	writeFileSync(join(evidence, 'grid-status-proof.json'), JSON.stringify({ working, needsInput }, null, 2));
	await capture('15-grid-needs-input');
	await proveAttachChildren();
	await allowUserClose(true);
	await command('View: Close All Editors');
	await until(async () => await win.locator('.tabs-container .tab').count() === 0, 'grid closed');
	await allowUserClose(false);
	assert.ok((await confirmations()).length > 0, 'default setting really confirms an explicit editor-terminal close');
	await openGrid();
	await until(async () => {
		const groups = await gridProof();
		return groups.length === 4 && groups.every((group: any) => group.tabs.length === 1 && /fake (claude|codex) ready/.test(group.text));
	}, 'reattached grid');
	const reused = (await request(0, 'workspaces/mac-demo/terminals')).filter((terminal: any) => names.includes(terminal.name));
	assert.deepEqual(reused.map((terminal: any) => terminal.id).sort(), gridTerminals.map((terminal: any) => terminal.id).sort());
	await win.locator('.tabs-container .tab').filter({ hasText: 'claude-1' }).click();
	await row('codex-2').locator('.label-name').click();
	await until(async () => await win.locator('.editor-group-container.active .tabs-container .tab.active').filter({ hasText: 'codex-2' }).count() === 1, 'sidebar focuses codex-2 pane');
	await capture('16-grid-reused-focused');
	writeFileSync(join(evidence, 'grid-reuse-proof.json'), JSON.stringify({ ids: reused.map((terminal: any) => terminal.id), groups: await gridProof() }, null, 2));
	console.log('PASS: 2×2 attached grid, four daemon/tmux sessions, live green spinner/red dot, reuse and sidebar focus');

	// A -> remote B -> A -> B, preserving daemon sessions and tmux screen contents.
	const gridSentinel = `grid-switch-${Date.now()}`;
	await win.evaluate((value: string) => { (window as any).__outscaledSwitchSentinel = value; }, gridSentinel);
	const gridHostsBefore = extensionPids();
	const extensionTunnels = () => readFileSync(sshLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.kind === 'extension-tunnel');
	const gridTunnelsBefore = extensionTunnels().map(entry => entry.pid);
	const marker = 'GRID_RESTORE_MARKER';
	await win.locator('.tabs-container .tab').filter({ hasText: 'codex-1' }).click();
	await win.locator('.editor-group-container.active .xterm-helper-textarea').focus();
	await win.keyboard.type(marker); await win.keyboard.press('Enter');
	await until(async () => (await gridProof()).some((group: any) => group.tabs.some((tab: any) => tab.name === 'codex-1') && group.text.includes(marker)), 'typed marker visible in codex pane');
	await capture('17-a-marker');
	const switchWorkspace = async (slug: string) => {
		await proveAttachChildren();
		await row(slug).locator('.label-name').click(); await selected(slug);
		await assertNoUnexpectedConfirmations();
	};
	const paneNames = async () => (await gridProof()).flatMap((group: any) => group.tabs.map((tab: any) => tab.name)).sort();
	await switchWorkspace('vps-demo');
	await until(async () => !(await paneNames()).some((name: string) => names.includes(name)), 'A panes detached on B');
	// The earlier filesystem test remembered a remote file editor. Start this
	// scenario with just terminal panes, as on A above.
	await command('View: Close All Editors');
	await openGrid('1 Claude + shell');
	await until(async () => {
		const groups = await gridProof();
		return groups.length === 2 && groups[0].text.includes('fake claude ready') && groups[1].text.length > 0;
	}, 'remote B attached side-by-side grid');
	assert.deepEqual(await paneNames(), ['claude-1', 'shell-1']);
	const bGroups = await gridProof();
	assert.equal(bGroups[0].y, bGroups[1].y); assert.ok(bGroups[0].x < bGroups[1].x);
	const bTerminals = await request(1, 'workspaces/vps-demo/terminals');
	const identities = (terminals: any[]) => terminals.map(({ id, session, name, pid, createdAt }) => ({ id, session, name, pid, createdAt })).sort((a, b) => a.id.localeCompare(b.id));
	await capture('18-b-grid');
	await switchWorkspace('mac-demo');
	await until(async () => {
		const groups = await gridProof();
		return groups.length === 4 && groups.every((group: any) => group.tabs.length === 1 && /fake (claude|codex) ready/.test(group.text)) && groups.some((group: any) => group.text.includes(marker));
	}, 'A restored 2x2 with marker');
	assert.deepEqual(await paneNames(), [...names].sort());
	const restoredA = (await gridProof()).sort((a: any, b: any) => a.y - b.y || a.x - b.x);
	assert.deepEqual(restoredA.map((group: any) => group.tabs[0].name), names);
	assert.equal(restoredA[0].y, restoredA[1].y); assert.equal(restoredA[2].y, restoredA[3].y);
	assert.ok(restoredA[0].y < restoredA[2].y && restoredA[0].x < restoredA[1].x);
	assert.deepEqual(identities((await request(0, 'workspaces/mac-demo/terminals')).filter((terminal: any) => names.includes(terminal.name))), identities(gridTerminals));
	await request(0, 'hooks/claude-code', { terminal: claude.id, payload: { hook_event_name: 'UserPromptSubmit' } });
	await until(async () => await tab.locator('[class*="codicon-loading~spin"]').count() > 0, 'restored A live working spinner');
	const restoredStatus = await gridProof();
	assert.ok(restoredStatus.some((group: any) => group.tabs.some((tab: any) => tab.name === 'claude-1' && tab.icons.some((icon: any) => icon.color === 'rgb(13, 188, 121)' || icon.beforeColor === 'rgb(13, 188, 121)'))));
	await capture('19-a-restored-live');
	await switchWorkspace('vps-demo');
	await until(async () => (await gridProof()).length === 2 && (await paneNames()).join() === 'claude-1,shell-1', 'B side-by-side restored');
	await until(async () => (await gridProof())[0].text.includes('fake claude ready'), 'B reattached output');
	assert.deepEqual(identities(await request(1, 'workspaces/vps-demo/terminals')), identities(bTerminals));
	const restoredB = await gridProof();
	assert.equal(restoredB[0].y, restoredB[1].y); assert.ok(restoredB[0].x < restoredB[1].x);
	await capture('20-b-restored');
	assert.equal(await win.evaluate(() => (window as any).__outscaledSwitchSentinel), gridSentinel, 'renderer survived grid switches');
	assert.deepEqual(extensionPids(), gridHostsBefore, 'extension host survived grid switches');
	assert.deepEqual(extensionTunnels().map(entry => entry.pid), gridTunnelsBefore, 'shared extension tunnel survived grid switches');
	writeFileSync(join(evidence, 'grid-switch-proof.json'), JSON.stringify({ marker, sentinel: gridSentinel,
		extensionHostPidsBefore: gridHostsBefore, extensionHostPidsAfter: extensionPids(), restoredA, restoredStatus, restoredB,
		aSessions: identities(gridTerminals), bSessions: identities(bTerminals) }, null, 2));
	await command('Developer: Reload Window');
	await until(async () => {
		try { return await win.evaluate(() => (window as any).__outscaledSwitchSentinel === undefined); } catch { return false; }
	}, 'grid deliberate reload');
	await row('vps-demo').waitFor({ state: 'visible' }); await selected('vps-demo');
	await until(async () => {
		const groups = await gridProof();
		return groups.length === 2 && groups[0].text.includes('fake claude ready') && (await paneNames()).join() === 'claude-1,shell-1';
	}, 'selected B grid restored after reload');
	assert.deepEqual(identities(await request(1, 'workspaces/vps-demo/terminals')), identities(bTerminals));
	assert.equal(extensionPids().length, gridHostsBefore.length + 1, 'only deliberate grid reload restarted extension host');
	await capture('21-b-after-reload');
	writeFileSync(join(evidence, 'grid-reload-proof.json'), JSON.stringify({ groups: await gridProof(), extensionHostPids: extensionPids(), sessions: identities(bTerminals) }, null, 2));
	console.log('PASS: A/B grids restore without reload/restart, same daemon sessions and typed marker, live tab colour, selected grid restored after reload');
	await installTerminalProbe();

	// Manual changes, including moving a terminal between groups, become the grid.
	await switchWorkspace('mac-demo');
	await until(async () => (await paneNames()).join() === [...names].sort().join(), 'A restored for manual edits');
	await win.locator('.tabs-container .tab').filter({ hasText: 'codex-1' }).click();
	await command('View: Move Editor into Next Group');
	await until(async () => (await gridProof()).some((group: any) => group.tabs.some((tab: any) => tab.name === 'codex-1') && group.tabs.some((tab: any) => tab.name === 'codex-2')), 'codex panes moved into same group');
	await win.locator('.tabs-container .tab').filter({ hasText: 'claude-2' }).click();
	await allowUserClose(true);
	await win.keyboard.press('Meta+w');
	await until(async () => !(await paneNames()).includes('claude-2'), 'user-closed claude pane');
	await allowUserClose(false);
	const editedGroups = (await gridProof()).map((group: any) => group.tabs.map((tab: any) => tab.name));
	await switchWorkspace('vps-demo');
	await until(async () => (await paneNames()).join() === 'claude-1,shell-1', 'B after manual A edits');
	await switchWorkspace('mac-demo');
	await until(async () => (await paneNames()).join() === 'claude-1,codex-1,codex-2', 'A restores actual remaining panes');
	assert.deepEqual((await gridProof()).map((group: any) => group.tabs.map((tab: any) => tab.name)), editedGroups);
	assert.equal((await request(0, 'workspaces/mac-demo/terminals')).find((terminal: any) => terminal.name === 'claude-2').state, 'running', 'closing client only detaches');
	await capture('22-manual-grid-restored');
	await switchWorkspace('vps-demo');
	await until(async () => (await paneNames()).join() === 'claude-1,shell-1', 'B before daemon exit');
	const exited = gridTerminals.find((terminal: any) => terminal.name === 'codex-2');
	process.kill(exited.pid, 'SIGKILL');
	await until(async () => (await request(0, 'workspaces/mac-demo/terminals')).find((terminal: any) => terminal.id === exited.id)?.state !== 'running', 'remembered daemon terminal exited');
	await switchWorkspace('mac-demo');
	await until(async () => (await paneNames()).join() === 'claude-1,codex-1', 'restore omits exited terminal without failing other panes');
	assert.deepEqual((await request(0, 'workspaces/mac-demo/terminals')).filter((terminal: any) => names.includes(terminal.name)).map((terminal: any) => terminal.id).sort(), gridTerminals.map((terminal: any) => terminal.id).sort(), 'restore created no daemon terminals');
	assert.equal((await request(0, 'workspaces/mac-demo/terminals')).find((terminal: any) => terminal.id === exited.id).state, 'exited', 'restore did not restart exited agent');
	await capture('23-exited-pane-omitted');
	console.log('PASS: manual cross-group moves and closes remembered; exited daemon pane omitted without restarting it');
	await assertNoUnexpectedConfirmations();
	writeFileSync(join(evidence, 'detach-dialog-proof.json'), JSON.stringify(await confirmations(), null, 2));
	console.log('PASS: default confirmOnKill, detected/live attach children on every grid switch, zero native termination prompts during detach');
	// A permission request for a detached workspace must dispatch a native-toast
	// command without its disposed process id. A click restores then focuses it.
	await request(0, 'hooks/claude-code', { terminal: claude.id, payload: { hook_event_name: 'Stop' } });
	await until(async () => (await row('claude-1').first().innerText()).includes('idle'), 'local notification baseline idle');
	await switchWorkspace('vps-demo');
	await until(async () => (await paneNames()).join() === 'claude-1,shell-1', 'remote grid selected before notification');
	const notificationId = `outscaled:${JSON.stringify(['local', claude.id, 'needs_input'])}`;
	writeFileSync(notificationControl, JSON.stringify({ hold: notificationId }));
	const notifications = () => readFileSync(notificationLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	const before = notifications().length;
	await request(0, 'hooks/claude-code', { terminal: claude.id, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } });
	await until(() => notifications().slice(before).some(request => request.id === notificationId), 'native notification command captured');
	const notification = notifications().slice(before).find(request => request.id === notificationId);
	assert.equal(notification.title, 'claude-1 · mac-demo · local');
	assert.equal(notification.body, 'Needs your input');
	assert.equal(notification.processId, undefined, 'detached pane process id is omitted');
	await capture('24-notification-other-workspace');
	await proveAttachChildren();
	writeFileSync(notificationControl, JSON.stringify({ click: notificationId }));
	await selected('mac-demo');
	await until(async () => (await paneNames()).join() === 'claude-1,codex-1', 'notification click restores remembered grid');
	await until(async () => await win.locator('.editor-group-container.active .tabs-container .tab.active').filter({ hasText: 'claude-1' }).count() === 1,
		'notification click focuses claude-1 pane');
	await until(async () => await win.evaluate(() => !!document.activeElement?.closest('.terminal-wrapper')), 'terminal receives keyboard focus');
	const activeElement = await win.evaluate(() => ({ tag: document.activeElement?.tagName, className: document.activeElement?.className }));
	writeFileSync(join(evidence, 'notification-click-proof.json'), JSON.stringify({ notification, selected: 'mac-demo', activeElement, groups: await gridProof(),
		verified: 'Real daemon hook -> shared state -> notify command; simulated clicked result -> workspace switch and terminal keyboard focus',
		notVerified: 'Native OS notification display, OS click delivery, and bringing a background window forward (probe replaces native command)' }, null, 2));
	await capture('25-notification-click-focused');
	console.log('PASS: permission hook dispatched correct notification id/title/body without stale processId; simulated click restored workspace grid and focused its terminal');
	await assertNoUnexpectedConfirmations();
	writeFileSync(join(evidence, 'detach-dialog-proof.json'), JSON.stringify(await confirmations(), null, 2));
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
	await until(() => extensionTunnels().every(invocation => { try { process.kill(invocation.pid, 0); return false; } catch { return true; } }), 'extension tunnel cleanup');
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
