/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Hermetic agents-view acceptance check. Builds must be current.
// scripts/serial.sh node extensions/outscaled/test/ui.mts <evidence-folder>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication, Page, ConsoleMessage } from 'playwright-core';
import type { ServicesAccessor } from '../../../src/vs/platform/instantiation/common/instantiation.js';
import type { ITerminalService, ITerminalInstance } from '../../../src/vs/workbench/contrib/terminal/browser/terminal.js';
import type { IAgentsService } from '../../../src/vs/workbench/contrib/outscaled/browser/agentsService.js';
import type { ICommandService } from '../../../src/vs/platform/commands/common/commands.js';
interface Probe {
	agents: IAgentsService; terminals: ITerminalService; commands: ICommandService;
	originals: ITerminalInstance[]; xterms: ITerminalInstance['xterm'][];
	openFile(resource: string): Promise<void>;
}
type ProbedWindow = Window & { __agentsProbe: Probe };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'package.json'));
const { _electron } = require('playwright-core') as typeof import('playwright-core');
const product = require(join(root, 'product.json'));
const evidence = resolve(process.argv[2] ?? join(root, '.agent-validation/agents-view')); mkdirSync(evidence, { recursive: true });
if (process.env.UI_INSPECT_LAUNCH) { rmSync(join(evidence, 'launch-inspected'), { force: true }); }
const temporary = mkdtempSync(join(tmpdir(), 'outscaled-agents-'));
const bin = join(temporary, 'bin'); mkdirSync(bin);
const config = join(temporary, 'config'); mkdirSync(config);
const folder = join(temporary, 'workspace'); mkdirSync(folder);
const profile = join(temporary, 'profile'); mkdirSync(join(profile, 'User'), { recursive: true });
const socket = join(temporary, 'tmux.sock');
const sshLog = join(evidence, 'ssh.jsonl'); writeFileSync(sshLog, '');
let daemon: ChildProcess | undefined;
let app: ElectronApplication;
let win: Page;
const errors: string[] = [];
const rendererErrors: string[] = [];
async function until(check: () => Promise<boolean> | boolean, message: string, timeout = 30000) {
	const deadline = Date.now() + timeout;
	while (!await check()) { if (Date.now() > deadline) {throw new Error(`Timed out: ${message}`);} await delay(100); }
}
const server = createServer();
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
await new Promise<void>(resolve => server.close(() => resolve()));
assert.notEqual(port, 7770);
async function request(path: string, body?: unknown) {
	const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, { method: body === undefined ? 'GET' : 'POST',
		headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
	assert.ok(response.ok, `${path}: ${response.status}`);
	return response.status === 204 ? undefined : response.json();
}
const capture = async (name: string) => { console.log('CAPTURE', name); await win.screenshot({ path: join(evidence, name + '.png') }); };
const proof = () => win.locator('.outscaled-agent-pane').evaluateAll((panes: Element[]) => panes.map(pane => {
	const bounds = pane.getBoundingClientRect();
	return { id: (pane as HTMLElement).dataset.terminalId, instanceId: (pane as HTMLElement).dataset.instanceId,
		status: (pane as HTMLElement).dataset.status, dot: getComputedStyle(pane.querySelector('.outscaled-status-dot')!).backgroundColor,
		text: (pane.querySelector('.xterm-accessibility-tree') as HTMLElement)?.innerText,
		x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}));
try {
	for (const agent of ['claude', 'codex']) {writeFileSync(join(bin, agent), `#!/bin/sh\necho 'fake ${agent} ready — AGENTS_VIEW'\nwhile IFS= read -r line; do\nif [ "$line" = HISTORY ]; then i=1; while [ "$i" -le 80 ]; do echo "AGENTS_HISTORY_$i"; i=$((i+1)); done; echo 'fake ${agent} ready — AGENTS_VIEW'; fi\necho "received:$line"\ndone\n`, { mode: 0o755 });}
	writeFileSync(join(bin, 'ssh'), `#!${process.execPath}
const {appendFileSync}=require('node:fs');
const {connect,createServer}=require('node:net');
const args=process.argv.slice(2), forward=args[args.indexOf('-L')+1];
const record=kind=>appendFileSync(process.env.TEST_SSH_LOG,JSON.stringify({pid:process.pid,args,kind})+'\\n');
if(args[0]==='-t'&&args[1]==='example-alias'){
 const command=args.slice(2).map(arg=>arg.replace(/^'|'$/g,''));
 if(JSON.stringify(command.slice(0,-1))!==JSON.stringify(['sudo','-n','-u','ws','-H','tmux','-u','attach-session','-t'])||!/^=ws-vps-demo-[a-z0-9-]+$/.test(command.at(-1)))process.exit(255);
 record('attach');
 const child=require('node:child_process').spawn('tmux',['-u','-S',process.env.WSD_TMUX_SOCKET,'attach-session','-t',command.at(-1)],{stdio:'inherit'});
 for(const signal of ['SIGTERM','SIGHUP','SIGINT'])process.on(signal,()=>child.kill(signal));
 child.on('exit',code=>process.exit(code??1));
}else{
 if(args.at(-1)!=='example-alias'||!args.includes('-L'))process.exit(255);
 const tcp=/^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:7770$/.test(forward);
 const unix=forward.endsWith(':127.0.0.1:'+process.env.WSD_PORT)&&forward.startsWith(require('node:os').tmpdir()+'/ws-');
 if(!tcp&&!unix)process.exit(255);
 record(tcp?'extension-tunnel':'cli-tunnel');
 const server=createServer(socket=>{const remote=connect({host:'127.0.0.1',port:Number(process.env.WSD_PORT)});socket.pipe(remote).pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());});
 if(tcp)server.listen(Number(forward.split(':')[1]),'127.0.0.1');else server.listen(forward.slice(0,forward.lastIndexOf(':127.0.0.1:')));
}
`, { mode: 0o755 });
	writeFileSync(join(config, 'servers.toml'), '');
	writeFileSync(join(config, 'config.toml'), 'name = "agents-fixture"\n');
	writeFileSync(join(folder, 'README.md'), '# Agents view\n\nNative Code mode workspace file.\n');
	const second = join(temporary, 'second'); mkdirSync(second); writeFileSync(join(second, 'README.md'), '# Second workspace\n');
	const env = { ...process.env, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}`, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1',
		TEST_SSH_LOG: sshLog, WSD_PORT: String(port), WSD_TMUX_SOCKET: socket, WSD_CONFIG_DIR: config, WSD_STATE_DIR: join(temporary, 'state'),
		WSD_WORKSPACES_DIR: join(temporary, 'workspaces'), OUTSCALED_CONFIG_DIR: config };
	delete env.ELECTRON_RUN_AS_NODE; delete env.GIT_CONFIG_COUNT; delete env.GIT_CONFIG_PARAMETERS;
	assert.equal(spawnSync('tmux', ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'fixture', '/bin/sleep 3600'], { env }).status, 0);
	assert.equal(spawnSync('tmux', ['-S', socket, 'set-option', '-g', 'status', 'off']).status, 0);
	daemon = spawn(join(root, 'daemon/dist/wsd'), [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	let daemonLog = '';
	daemon.stdout!.on('data', chunk => { daemonLog += chunk; }); daemon.stderr!.on('data', chunk => { daemonLog += chunk; });
	await until(async () => { if (daemon!.exitCode !== null) {throw new Error(daemonLog);} try { await request('health'); return true; } catch { return false; } }, 'daemon health');
	await request('workspaces', { slug: 'agents-demo', path: folder });
	await request('workspaces', { slug: 'second-demo', path: second });
	writeFileSync(join(profile, 'User/settings.json'), JSON.stringify({ 'window.title': 'Outscaled agents acceptance',
		'window.confirmSaveUntitledWorkspace': false, 'files.simpleDialog.enable': true,
		'outscaled.wsPath': join(root, 'daemon/dist/ws'), 'editor.accessibilitySupport': 'on' }));
	app = await _electron.launch({ executablePath: join(root, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort),
		args: [root, folder, '--user-data-dir', profile, '--shared-data-dir', join(temporary, 'shared'), '--extensions-dir', join(temporary, 'ext'),
			'--skip-release-notes', '--skip-welcome', '--disable-workspace-trust', '--disable-telemetry', '--disable-updates',
			'--disable-extension=vscode.vscode-api-tests', '--disable-extension=vscode.json-language-features'], env, timeout: 120000 });
	win = await app.firstWindow(); win.setDefaultTimeout(30000);
	win.on('pageerror', (error: Error) => { errors.push(error.message); console.error(error); });
	win.on('console', (message: ConsoleMessage) => { if (message.type() === 'error') {rendererErrors.push(message.text());} });
	await win.waitForSelector('.outscaled-title-controls');
	await win.locator('.outscaled-agents-host').waitFor();
	await win.locator('.sidebar .monaco-list-row').filter({ hasText: 'agents-demo' }).waitFor();
	await capture('00-launch');
	if (process.env.UI_INSPECT_LAUNCH) {
		console.log('Inspect 00-launch.png, then create launch-inspected in the evidence folder.');
		await until(() => existsSync(join(evidence, 'launch-inspected')), 'visual launch inspection', 180000);
	}
	await win.locator('.sidebar .monaco-list-row').filter({ hasText: 'agents-demo' }).locator('.label-name').click();
	await until(async () => await win.locator('.outscaled-workspace-name').innerText() === 'agents-demo', 'selected workspace after dedicated-window reload', 60000);
	// Inspect object identity and complete xterm buffers through a test-only command.
	await win.evaluate(async (base: string) => {
		const { CommandsRegistry } = await import(base + 'vs/platform/commands/common/commands.js');
		const { MenuRegistry, MenuId } = await import(base + 'vs/platform/actions/common/actions.js');
		const { IAgentsService } = await import(base + 'vs/workbench/contrib/outscaled/browser/agentsService.js');
		const { ITerminalService } = await import(base + 'vs/workbench/contrib/terminal/browser/terminal.js');
		const { IEditorService } = await import(base + 'vs/workbench/services/editor/common/editorService.js');
		const { URI } = await import(base + 'vs/base/common/uri.js');
		const { ICommandService } = await import(base + 'vs/platform/commands/common/commands.js');
						CommandsRegistry.registerCommand('outscaled.agentsProbe', (accessor: ServicesAccessor) => {
			const editors = accessor.get(IEditorService);
			(window as ProbedWindow).__agentsProbe = { agents: accessor.get(IAgentsService), terminals: accessor.get(ITerminalService), commands: accessor.get(ICommandService), originals: [], xterms: [], openFile: async resource => { await editors.openEditor({ resource: URI.parse(resource), options: { pinned: true } }); } };
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: 'outscaled.agentsProbe', title: 'Outscaled Agents Probe' } });
	}, pathToFileURL(join(root, 'out/')).href.replace('file://', 'vscode-file://vscode-app'));
	await win.keyboard.press('F1'); await win.locator('.quick-input-widget input').fill('>Outscaled Agents Probe');
	await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Outscaled Agents Probe' }).first().waitFor(); await win.keyboard.press('Enter');
	await until(async () => await win.evaluate(() => !!(window as ProbedWindow).__agentsProbe), 'probe');
	const command = (id: string, ...args: unknown[]) => win.evaluate(([id, args]: [string, unknown[]]) => (window as ProbedWindow).__agentsProbe.commands.executeCommand(id, ...args), [id, args]);
	const openPreset = async (label: string) => {
		await win.locator('.outscaled-title-controls').getByRole('button', { name: 'New agents', exact: true }).click();
		await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: label }).click();
	};
	const switchWorkspace = async (slug: string, host = 'local') => {
		await command('outscaled.switchWorkspace', { host, slug });
		await until(async () => await win.locator('.outscaled-workspace-name').innerText() === slug, `switch to ${slug}`);
	};
	await openPreset('2 Claude + 2 Codex');
	await until(async () => { const panes = await proof(); return panes.length === 4 && panes.every((pane: any) => pane.text?.includes('AGENTS_VIEW')); }, 'four live xterms', 15000);
	await command('workbench.action.splitEditor');
	assert.equal(await win.locator('.part.editor .editor-group-container').count(), 1, 'Agents stays a single editor group');
	const terminals = await request('workspaces/agents-demo/terminals');
	const target = terminals.find((terminal: any) => terminal.name === 'claude-1');
	await request('hooks/claude-code', { terminal: target.id, payload: { hook_event_name: 'Stop' } });
	await until(async () => (await proof())[0].status === 'idle', 'idle baseline');
	const initial = await proof();
	assert.equal(initial[0].y, initial[1].y); assert.equal(initial[2].y, initial[3].y);
	assert.equal(initial[0].x, initial[2].x); assert.ok(initial[1].x > initial[0].x && initial[2].y > initial[0].y);
	assert.equal(await win.locator('.tabs-container .tab:visible').count(), 0);
	assert.deepEqual(await win.locator('.outscaled-runtime-badge').allTextContents(), ['Claude', 'Claude', 'Codex', 'Codex']);
	assert.deepEqual(await win.locator('.outscaled-agent-name').allTextContents(), ['claude-1', 'claude-2', 'codex-1', 'codex-2']);
	await capture('01-agents');
	await request('hooks/claude-code', { terminal: target.id, payload: { hook_event_name: 'UserPromptSubmit' } });
	await until(async () => (await proof())[0].status === 'working', 'working dot');
	const working = await proof(); assert.notEqual(working[0].dot, initial[0].dot); await capture('02-working');
	await switchWorkspace('second-demo'); await openPreset('1 Claude + shell');
	await until(async () => (await proof()).length === 2 && (await proof())[0].text?.includes('AGENTS_VIEW'), 'second grid');
	const secondTerminals = await request('workspaces/second-demo/terminals');
	const secondGrid = await proof(); await capture('03-second');
	await request('hooks/claude-code', { terminal: target.id, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } });
	await win.locator('.outscaled-needs-you').getByText('1 need you', { exact: true }).waitFor();
	await capture('04-needs-you-another-workspace');
	await win.locator('.outscaled-needs-you').click();
	await until(async () => (await proof()).length === 4 && await win.locator('.outscaled-workspace-name').innerText() === 'agents-demo', 'needs-you cross-workspace focus');
	await until(async () => await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id')) === target.id, 'waiting pane receives focus');
	const needsInput = await proof(); assert.notEqual(needsInput[0].dot, working[0].dot);
	assert.equal(await win.locator('.outscaled-agent-pane').first().evaluate((pane: Element) => getComputedStyle(pane).borderColor === getComputedStyle(pane.querySelector('.outscaled-status-dot')!).backgroundColor), true);
	await capture('05-needs-you-focused');
	await win.locator('.outscaled-agent-pane').nth(2).locator('.xterm-helper-textarea').focus();
	await win.keyboard.type('HISTORY'); await win.keyboard.press('Enter');
	await until(async () => (await proof())[2].text.includes('received:HISTORY'), 'third pane typed input');
	await app.evaluate(({ clipboard }) => clipboard.writeText('PASTED_TO_THIRD'));
	await win.keyboard.press('Meta+v'); await win.keyboard.press('Enter');
	await until(async () => (await proof())[2].text.includes('received:PASTED_TO_THIRD'), 'native paste');
	await command('workbench.action.terminal.selectAll');
	await win.keyboard.press('Meta+c');
	await until(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).includes('PASTED_TO_THIRD'), 'native copy of selected third pane');
	await command('workbench.action.terminal.clearSelection');
	await win.keyboard.press('Meta+f');
	await win.locator('.outscaled-agent-pane').nth(2).locator('.simple-find-part.visible').waitFor();
	await until(async () => {
		const pane = win.locator('.outscaled-agent-pane').nth(2);
		const widget = await pane.locator('.simple-find-part.visible').boundingBox();
		const body = await pane.locator('.outscaled-agent-body').boundingBox();
		return !!widget && !!body && widget.y >= body.y;
	}, 'find widget fully visible within third pane');
	await win.locator('.outscaled-agent-pane').nth(2).locator('.simple-find-part input').fill('PASTED_TO_THIRD');
	await capture('06-native-find'); await win.keyboard.press('Escape');
	await command('workbench.action.terminal.focus');
	assert.equal(await win.locator('.outscaled-agent-pane').count(), 4);
	assert.equal(await win.locator('.tabs-container .tab:visible').count(), 0);
	const before = await win.evaluate(() => {
		const probe = (window as ProbedWindow).__agentsProbe;
		probe.originals = [...probe.terminals.instances];
		probe.xterms = probe.originals.map((instance: any) => instance.xterm);
		return probe.originals.map((instance: any) => ({ instanceId: instance.instanceId, processId: instance.processId }));
	});
	const historyTarget = terminals.find((terminal: any) => terminal.name === 'codex-1').session;
	const tmuxHistory = () => { const result = spawnSync('tmux', ['-S', socket, 'capture-pane', '-p', '-S', '-', '-t', historyTarget], { encoding: 'utf8' }); assert.equal(result.status, 0); return result.stdout.trimEnd(); };
	const historyBefore = tmuxHistory(); assert.ok(historyBefore.includes('AGENTS_HISTORY_1'));
	await win.locator('.outscaled-title-controls').getByRole('button', { name: 'Code', exact: true }).click();
	await win.locator('.sidebar .explorer-viewlet').waitFor();
	await win.evaluate(resource => (window as ProbedWindow).__agentsProbe.openFile(resource), pathToFileURL(join(folder, 'README.md')).href);
	await win.locator('.tabs-container .tab:visible').waitFor(); await capture('07-code');
	await command('workbench.view.search');
	await win.locator('.sidebar .search-view').waitFor();
	await request('hooks/claude-code', { terminal: target.id, payload: { hook_event_name: 'Stop' } });
	await until(async () => await win.evaluate(id => (window as ProbedWindow).__agentsProbe.agents.snapshot.workspaces.flatMap(workspace => workspace.terminals).find(terminal => terminal.id === id)?.status === 'idle', target.id), 'status while using Code search');
	assert.equal(await win.locator('.sidebar .search-view').isVisible(), true);

	await win.locator('.outscaled-title-controls').getByRole('button', { name: 'Agents', exact: true }).click();
	await until(async () => (await proof()).length === 4, 'agents with Code file remembered');
	await win.locator('.outscaled-title-controls').getByRole('button', { name: 'Code', exact: true }).click();
	await win.locator('.tabs-container .tab:visible').filter({ hasText: 'README.md' }).waitFor();
	await capture('07b-code-restored');
	await command('workbench.action.closeAllEditors');
	await win.locator('.outscaled-title-controls').getByRole('button', { name: 'Agents', exact: true }).click();
	await until(async () => (await proof()).length === 4 && (await proof())[2].text?.includes('PASTED_TO_THIRD'), 'agents survive close all Code editors');
	await until(async () => await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-instance-id') === document.querySelectorAll('.outscaled-agent-pane')[2].getAttribute('data-instance-id')), 'third pane focus restored');
	const after = await win.evaluate(() => {
		const probe = (window as ProbedWindow).__agentsProbe;
		return probe.terminals.instances.map((instance: any, index: number) => ({ instanceId: instance.instanceId, processId: instance.processId,
			sameInstance: instance === probe.originals[index], sameXterm: instance.xterm === probe.xterms[index] }));
	});
	assert.deepEqual(after.map((pane: any) => ({ instanceId: pane.instanceId, processId: pane.processId })), before);
	assert.ok(after.every((pane: any) => pane.sameInstance && pane.sameXterm));
	assert.ok(tmuxHistory().includes(historyBefore)); await capture('08-return');
	await switchWorkspace('second-demo'); assert.deepEqual((await proof()).map((pane: any) => pane.instanceId), secondGrid.map((pane: any) => pane.instanceId));
	await command('workbench.action.reloadWindow').catch(() => {});
	await win.waitForFunction(() => !(window as ProbedWindow).__agentsProbe);
	await until(async () => await win.locator('.outscaled-workspace-name').innerText().catch(() => '') === 'second-demo' && (await proof()).length === 2, 'second grid restored after reload', 60000);
	await capture('09-reloaded-second');
	// Inspect object identity and complete xterm buffers through a test-only command.
	await win.evaluate(async (base: string) => {
		const { CommandsRegistry } = await import(base + 'vs/platform/commands/common/commands.js');
		const { MenuRegistry, MenuId } = await import(base + 'vs/platform/actions/common/actions.js');
		const { IAgentsService } = await import(base + 'vs/workbench/contrib/outscaled/browser/agentsService.js');
		const { ITerminalService } = await import(base + 'vs/workbench/contrib/terminal/browser/terminal.js');
		const { IEditorService } = await import(base + 'vs/workbench/services/editor/common/editorService.js');
		const { URI } = await import(base + 'vs/base/common/uri.js');
		const { ICommandService } = await import(base + 'vs/platform/commands/common/commands.js');
						CommandsRegistry.registerCommand('outscaled.agentsProbe', (accessor: ServicesAccessor) => {
			const editors = accessor.get(IEditorService);
			(window as ProbedWindow).__agentsProbe = { agents: accessor.get(IAgentsService), terminals: accessor.get(ITerminalService), commands: accessor.get(ICommandService), originals: [], xterms: [], openFile: async resource => { await editors.openEditor({ resource: URI.parse(resource), options: { pinned: true } }); } };
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: 'outscaled.agentsProbe', title: 'Outscaled Agents Probe' } });
	}, pathToFileURL(join(root, 'out/')).href.replace('file://', 'vscode-file://vscode-app'));
	await win.keyboard.press('F1'); await win.locator('.quick-input-widget input').fill('>Outscaled Agents Probe');
	await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Outscaled Agents Probe' }).first().waitFor(); await win.keyboard.press('Enter');
	await until(async () => await win.evaluate(() => !!(window as ProbedWindow).__agentsProbe), 'probe');
	await switchWorkspace('agents-demo');
	await until(async () => (await proof()).length === 4 && (await proof())[2].text?.includes('PASTED_TO_THIRD'), 'first grid restored after reload');
	assert.deepEqual((await request('workspaces/agents-demo/terminals')).map((terminal: any) => [terminal.id, terminal.session, terminal.pid]), terminals.map((terminal: any) => [terminal.id, terminal.session, terminal.pid]));
	assert.deepEqual((await request('workspaces/second-demo/terminals')).map((terminal: any) => [terminal.id, terminal.session, terminal.pid]), secondTerminals.map((terminal: any) => [terminal.id, terminal.session, terminal.pid]));
	await capture('10-reloaded-first');
	const geometries: Record<string, unknown> = {};
	for (const [label, count] of [['Single', 1], ['Side by side', 2], ['Stacked', 2], ['2×2', 4], ['Four across', 4], ['Two stacked + right', 3]] as const) {
		await openPreset(`${label} · shells`);
		await until(async () => {
			const boxes = await proof();
			if (boxes.length !== count || !(await win.locator('.outscaled-runtime-badge').allTextContents()).every((text: string) => text === 'Shell')) { return false; }
			if (label === 'Side by side' || label === 'Four across') { return boxes.every((box: any) => box.y === boxes[0].y) && boxes[1].x > boxes[0].x; }
			if (label === 'Stacked') { return boxes[1].x === boxes[0].x && boxes[1].y > boxes[0].y; }
			if (label === '2×2') { return boxes[1].y === boxes[0].y && boxes[2].x === boxes[0].x && boxes[2].y > boxes[0].y; }
			if (label === 'Two stacked + right') { return boxes[1].x === boxes[0].x && boxes[2].y === boxes[0].y && boxes[2].height > boxes[0].height * 1.8; }
			return true;
		}, label);
		const boxes = await proof();
		if (label === 'Side by side' || label === 'Four across') { assert.ok(boxes.every((box: any) => box.y === boxes[0].y)); assert.ok(boxes[1].x > boxes[0].x); }
		if (label === 'Stacked') { assert.equal(boxes[1].x, boxes[0].x); assert.ok(boxes[1].y > boxes[0].y); }
		if (label === '2×2') { assert.equal(boxes[1].y, boxes[0].y); assert.equal(boxes[2].x, boxes[0].x); assert.ok(boxes[2].y > boxes[0].y); }
		if (label === 'Two stacked + right') { assert.equal(boxes[1].x, boxes[0].x); assert.equal(boxes[2].y, boxes[0].y); assert.ok(boxes[2].height > boxes[0].height * 1.8); }
		geometries[label] = boxes; await capture(`layout-${count}-${label.replaceAll(/[^a-zA-Z0-9]/g, '-')}`);
	}
	await openPreset('2 Claude + 2 Codex');
	await until(async () => (await proof()).length === 4 && (await proof())[2].text?.includes('PASTED_TO_THIRD'), 'preset reuses retained clients');
	// Exercise the retained VPS transport through a private SSH double. Both endpoints
	// use this fixture daemon; no connection is made to port 7770 or a real host.
	await request('hooks/claude-code', { terminal: target.id, payload: { hook_event_name: 'Stop' } });
	const remoteFolder = join(temporary, 'remote-workspace'); mkdirSync(remoteFolder); writeFileSync(join(remoteFolder, 'README.md'), '# Remote workspace\n');
	await request('workspaces', { slug: 'vps-demo', path: remoteFolder });
	writeFileSync(join(config, 'servers.toml'), '[[server]]\nhost = "example-alias"\n');
	await until(async () => await win.evaluate(() => (window as ProbedWindow).__agentsProbe.agents.snapshot.workspaces.some(workspace => workspace.server === 'example-alias' && workspace.online)), 'private VPS tunnel');
	await switchWorkspace('vps-demo', 'example-alias');
	await openPreset('1 Claude + shell');
	await until(async () => (await proof()).length === 2 && (await proof())[0].text?.includes('AGENTS_VIEW'), 'VPS panes attached through ws attach --on');
	const remote = await win.evaluate(() => {
		const probe = (window as ProbedWindow).__agentsProbe;
		const workspace = probe.agents.snapshot.workspaces.find(workspace => workspace.selected)!;
		return { root: workspace.root, launch: workspace.terminals.map(terminal => terminal.launch), receipt: probe.agents.receipt().panes?.filter(pane => pane.workspace === workspace.id) };
	});
	assert.equal(remote.root, 'ws://example-alias/vps-demo/');
	assert.ok(remote.launch.every((launch: any) => launch.args.slice(-2).join(' ') === '--on example-alias'));
	await win.locator('.outscaled-agent-pane').first().locator('.xterm-helper-textarea').focus();
	await win.keyboard.type('PRIVATE_REMOTE_INPUT'); await win.keyboard.press('Enter');
	await until(async () => (await proof())[0].text?.includes('received:PRIVATE_REMOTE_INPUT'), 'VPS input');
	await capture('11-vps-agents');
	await win.locator('.outscaled-title-controls').getByRole('button', { name: 'Code', exact: true }).click();
	await win.evaluate(() => (window as ProbedWindow).__agentsProbe.openFile('ws://example-alias/vps-demo/README.md'));
	await win.locator('.monaco-editor .view-line').filter({ hasText: '# Remote workspace' }).waitFor();
	await capture('12-vps-code');
	await command('workbench.action.splitEditor');
	assert.equal(await win.locator('.part.editor .editor-group-container').count(), 2, 'Code retains native editor splitting');
	await win.locator('.outscaled-title-controls').getByRole('button', { name: 'Agents', exact: true }).click();
	await until(async () => (await proof())[0]?.text?.includes('PRIVATE_REMOTE_INPUT'), 'VPS return');
	const ssh = readFileSync(sshLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
	assert.ok(ssh.some(entry => entry.kind === 'extension-tunnel'));
	assert.equal(ssh.filter(entry => entry.kind === 'attach').length, 2);
	writeFileSync(join(evidence, 'proof.json'), JSON.stringify({ initial, working, needsInput, before, after, terminals, secondTerminals, geometries, remote, ssh, errors }, null, 2));
	assert.deepEqual(errors, []);
	console.log('PASS: native commands, identity, tmux history, workspace/reload persistence, needs-you focus, six split geometries');
} finally {
	writeFileSync(join(evidence, 'page-errors.json'), JSON.stringify(errors, null, 2));
	writeFileSync(join(evidence, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2));
	if (app) {
		if (win) { try { await capture('last-state'); writeFileSync(join(evidence, 'last-dom.txt'), await win.locator('body').innerText()); writeFileSync(join(evidence, 'last-html.txt'), await win.locator('.outscaled-agents-host').evaluateAll((elements: Element[]) => elements.map(element => element.outerHTML).join('\n'))); writeFileSync(join(evidence, 'last-proof.json'), JSON.stringify(await proof(), null, 2)); writeFileSync(join(evidence, 'last-bridge.json'), JSON.stringify(await win.evaluate(() => ({ snapshot: (window as ProbedWindow).__agentsProbe.agents.snapshot, receipt: (window as ProbedWindow).__agentsProbe.agents.receipt(), instances: (window as ProbedWindow).__agentsProbe.terminals.instances.map(instance => ({id:instance.instanceId, disposed:instance.isDisposed, launch:instance.shellLaunchConfig})) })), null, 2)); } catch {} }
		const copyLogs = (directory: string, prefix = '') => { try { for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name); if (entry.isDirectory()) {copyLogs(path, prefix + entry.name + '-');}
			else if (entry.name.endsWith('.log')) {writeFileSync(join(evidence, prefix + entry.name), readFileSync(path));}
		} } catch {} };
		copyLogs(join(profile, 'logs'));
		await app.close().catch(() => {});
	}
	if (daemon && daemon.exitCode === null) { daemon.kill('SIGTERM'); await Promise.race([new Promise(resolve => daemon!.once('exit', resolve)), delay(5000)]); if (daemon.exitCode === null) {daemon.kill('SIGKILL');} }
	spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
	rmSync(temporary, { recursive: true, force: true });
	const sshPids = readFileSync(sshLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).pid as number);
	const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
	await until(() => sshPids.every(pid => !alive(pid)), 'fixture SSH processes stopped', 10000);
	writeFileSync(join(evidence, 'cleanup.json'), JSON.stringify({ sshStopped: true, daemonStopped: daemon?.exitCode !== null || daemon?.signalCode !== null, privateTmuxSocketRemoved: true, temporaryRemoved: true }));
}
