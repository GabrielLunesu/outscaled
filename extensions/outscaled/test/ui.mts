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
	selectionCount(): number;
}
type ProbedWindow = Window & { __agentsProbe: Probe };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'package.json'));
const { _electron } = require('playwright-core') as typeof import('playwright-core');
const product = require(join(root, 'product.json'));
assert.ok(existsSync(join(root, 'daemon/dist/wsd')), 'Build the fixture daemon with: cd daemon && ../scripts/serial.sh bun run build');
const evidence = resolve(process.argv[2] ?? join(root, '.agent-validation/agents-view')); mkdirSync(evidence, { recursive: true });
if (process.env.UI_INSPECT_LAUNCH) { rmSync(join(evidence, 'launch-inspected'), { force: true }); }
const temporary = mkdtempSync(join(tmpdir(), 'outscaled-agents-'));
const bin = join(temporary, 'bin'); mkdirSync(bin);
const config = join(temporary, 'config'); mkdirSync(config);
const folder = join(temporary, 'workspace'); mkdirSync(folder);
const profile = join(temporary, 'profile'); mkdirSync(join(profile, 'User'), { recursive: true });
const socket = join(temporary, 'tmux.sock');
const gitConfig = join(temporary, 'gitconfig'); writeFileSync(gitConfig, '');
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
const capture = async (name: string) => {
	if (name.startsWith('needs-you-')) { await until(async () => await win.locator('.terminal-resize-overlay.visible').count() === 0, 'terminal resize indicators settle'); }
	console.log('CAPTURE', name); await win.screenshot({ path: join(evidence, name + '.png') });
};
const proof = () => win.locator('.outscaled-agent-pane').evaluateAll((panes: Element[]) => panes.map(pane => {
	const bounds = pane.getBoundingClientRect();
	return { id: (pane as HTMLElement).dataset.terminalId, instanceId: (pane as HTMLElement).dataset.instanceId,
		status: (pane as HTMLElement).dataset.status, dot: getComputedStyle(pane.querySelector('.outscaled-status-dot')!).backgroundColor,
		text: (pane.querySelector('.xterm-accessibility-tree') as HTMLElement)?.innerText,
		x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}));
try {
	const agentLog = join(temporary, 'agent-args.jsonl');
	const permissionControl = join(temporary, 'permission-control'); mkdirSync(permissionControl);
	const permissionReport = join(evidence, 'permission-keys.jsonl'); writeFileSync(permissionReport, '');
	for (const agent of ['claude', 'codex']) { writeFileSync(join(bin, agent), `#!${process.execPath}
import(${JSON.stringify(pathToFileURL(join(root, 'extensions/outscaled/test/fakeAgent.mts')).href)}).then(({ runFakeAgent }) => runFakeAgent(${JSON.stringify(agent)}));
`, { mode: 0o755 }); }

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
	const gitAt = (directory: string, ...args: string[]) => {
		const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' } });
		assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
	};
	const git = (...args: string[]) => gitAt(folder, ...args);
	git('init', '-q', '-b', 'fixture-branch'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
	git('config', 'commit.gpgsign', 'false'); git('add', 'README.md'); git('commit', '-qm', 'Fixture baseline');
	const second = join(temporary, 'second'); mkdirSync(second); writeFileSync(join(second, 'README.md'), '# Second workspace\n');
	const env = { ...process.env, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}`, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1',
		GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
		TEST_AGENT_LOG: agentLog, TEST_SSH_LOG: sshLog, TEST_PERMISSION_CONTROL: permissionControl, TEST_PERMISSION_REPORT: permissionReport, TEST_PERMISSION_FIXTURES: join(root, 'daemon/test/fixtures/permissions'), WSD_PORT: String(port), WSD_TMUX_SOCKET: socket, WSD_CONFIG_DIR: config, WSD_STATE_DIR: join(temporary, 'state'),
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
		'window.confirmSaveUntitledWorkspace': false, 'window.menuStyle': 'custom', 'files.simpleDialog.enable': true,
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
	await win.locator('.outscaled-workspace-row').filter({ hasText: 'agents-demo' }).waitFor();
	assert.equal(await win.locator('[id="outscaled.workspaces"], [id="workbench.view.extension.outscaled"]').count(), 0, 'old extension tree is absent');
	assert.deepEqual(await win.locator('.outscaled-workspace-label').allTextContents(), ['agents-demo', 'second-demo']);
	assert.deepEqual(await win.locator('.outscaled-workspace-detail').allTextContents(), [`${folder} · fixture-branch`, second]);
	await capture('00-launch');
	await win.locator('.outscaled-background.empty').waitFor(); await capture('strip-empty');
	if (process.env.UI_INSPECT_LAUNCH) {
		console.log('Inspect 00-launch.png, then create launch-inspected in the evidence folder.');
		await until(() => existsSync(join(evidence, 'launch-inspected')), 'visual launch inspection', 180000);
	}
	await win.locator('.outscaled-workspace-row').filter({ hasText: 'agents-demo' }).click();
	await until(async () => await win.locator('.outscaled-workspace-name').innerText() === 'agents-demo', 'selected workspace after dedicated-window reload', 60000);
	// Inspect object identity and complete xterm buffers through a test-only command.
	const installProbe = async () => {
		await win.evaluate(async (base: string) => {
			const { CommandsRegistry } = await import(base + 'vs/platform/commands/common/commands.js');
			const { MenuRegistry, MenuId } = await import(base + 'vs/platform/actions/common/actions.js');
			const { IAgentsService } = await import(base + 'vs/workbench/contrib/outscaled/browser/agentsService.js');
			const { ITerminalService } = await import(base + 'vs/workbench/contrib/terminal/browser/terminal.js');
			const { IEditorService } = await import(base + 'vs/workbench/services/editor/common/editorService.js');
			const { ICodeEditorService } = await import(base + 'vs/editor/browser/services/codeEditorService.js');
			const { URI } = await import(base + 'vs/base/common/uri.js');
			const { ICommandService } = await import(base + 'vs/platform/commands/common/commands.js');
			CommandsRegistry.registerCommand('outscaled.agentsProbe', (accessor: ServicesAccessor) => {
				const editors = accessor.get(IEditorService);
				const codeEditors = accessor.get(ICodeEditorService);
				(window as ProbedWindow).__agentsProbe = { agents: accessor.get(IAgentsService), terminals: accessor.get(ITerminalService), commands: accessor.get(ICommandService), originals: [], xterms: [], selectionCount: () => codeEditors.getFocusedCodeEditor()?.getSelections()?.length ?? 0, openFile: async resource => { await editors.openEditor({ resource: URI.parse(resource), options: { pinned: true } }); } };
			});
			MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: 'outscaled.agentsProbe', title: 'Outscaled Agents Probe' } });
		}, pathToFileURL(join(root, 'out/')).href.replace('file://', 'vscode-file://vscode-app'));
		await win.keyboard.press('F1'); await win.locator('.quick-input-widget input').fill('>Outscaled Agents Probe');
		await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Outscaled Agents Probe' }).first().waitFor(); await win.keyboard.press('Enter');
		await until(async () => await win.evaluate(() => !!(window as ProbedWindow).__agentsProbe), 'probe');
	};
	await installProbe();
	const command = (id: string, ...args: unknown[]) => win.evaluate(([id, args]: [string, unknown[]]) => (window as ProbedWindow).__agentsProbe.commands.executeCommand(id, ...args), [id, args]);
	const openPreset = async (label: string) => {
		const opening = command('outscaled.openGrid');
		await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: label }).click();
		await opening;
	};
	const switchWorkspace = async (slug: string, host = 'local') => {
		await command('outscaled.switchWorkspace', { host, slug });
		await until(async () => await win.locator('.outscaled-workspace-name').innerText() === slug, `switch to ${slug}`);
	};
	// Await the initial root transition as well as its early title update.
	await switchWorkspace('agents-demo');
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
	assert.deepEqual(await win.locator('.outscaled-agent-pane .outscaled-runtime-badge').allTextContents(), ['Claude', 'Claude', 'Codex', 'Codex']);
	assert.deepEqual(await win.locator('.outscaled-agent-name').allTextContents(), ['claude-1', 'claude-2', 'codex-1', 'codex-2']);
	await capture('01-agents');
	await request('hooks/claude-code', { terminal: target.id, payload: { hook_event_name: 'UserPromptSubmit' } });
	await until(async () => (await proof())[0].status === 'working', 'working dot');
	const working = await proof(); assert.notEqual(working[0].dot, initial[0].dot); await capture('02-working');
	await switchWorkspace('second-demo'); await openPreset('1 Claude + shell');
	await until(async () => (await proof()).length === 2 && (await proof())[0].text?.includes('AGENTS_VIEW'), 'second grid');
	const secondTerminals = await request('workspaces/second-demo/terminals');
	const secondGrid = await proof(); await capture('03-second');
	const row = (name: string) => win.locator('.outscaled-workspace-row').filter({ has: win.locator('.outscaled-workspace-label', { hasText: name }) }).first();
	const selected = async (name: string) => {
		await until(async () => await win.locator('.outscaled-workspace-name').innerText() === name, `sidebar switch to ${name}`);
		// Wait for root restoration and its focus callback before sending another key.
		await command('outscaled.switchWorkspace', { host: 'local', slug: name });
	};
	const shortcut = async (number: number, name: string) => {
		await win.keyboard.press(`Meta+${number}`); await selected(name);
		// The title updates before the native root change. A queued no-op switch
		// waits for that shortcut's complete extension/core transition.
		await command('outscaled.switchWorkspace', { host: 'local', slug: name });
	};
	await shortcut(1, 'agents-demo'); await shortcut(2, 'second-demo');
	await row('agents-demo').focus(); await win.keyboard.press('ArrowDown'); await win.keyboard.press('Enter'); await selected('second-demo');
	await win.keyboard.press('ArrowUp'); await win.keyboard.press('Enter'); await selected('agents-demo');
	await win.keyboard.press('ArrowDown'); await win.keyboard.press('Enter'); await selected('second-demo');
	assert.equal(await row('second-demo').evaluate(element => element === document.activeElement), true, 'list retains keyboard focus after switching');
	assert.equal(await row('agents-demo').locator('.outscaled-workspace-dot').count(), 4);
	assert.equal(await row('second-demo').locator('.outscaled-workspace-dot').count(), 2);
	assert.equal(await row('second-demo').locator('.outscaled-workspace-badge').isVisible(), false);
	const stableRow = await row('second-demo').elementHandle();
	const stableDot = await row('agents-demo').locator('.outscaled-workspace-dot').first().elementHandle();
	await request('hooks/claude-code', { terminal: target.id, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } });
	await win.locator('.outscaled-needs-you').getByText('1 need you', { exact: true }).waitFor();
	await until(async () => await row('agents-demo').locator('.outscaled-workspace-badge').innerText() === '1' && await row('agents-demo').locator('.outscaled-workspace-dot').first().getAttribute('data-status') === 'needs_input', 'unselected row badge and red dot');
	assert.equal(await stableRow!.evaluate(element => element.isConnected && element === document.activeElement), true, 'status update retains row and focus');
	assert.equal(await stableDot!.evaluate(element => element.isConnected), true, 'status update retains dot');
	await stableRow!.dispose(); await stableDot!.dispose();
	await row('agents-demo').locator('.outscaled-workspace-dot').first().hover();
	await win.locator('.monaco-hover').filter({ hasText: 'claude-1: Needs You' }).waitFor();
	await capture('04-needs-you-another-workspace');
	await row('agents-demo').locator('.outscaled-workspace-label').click(); await selected('agents-demo');
	assert.equal(await row('agents-demo').getAttribute('aria-selected'), 'true');
	await shortcut(2, 'second-demo');
	await win.locator('.outscaled-needs-you').click();
	await win.locator('.outscaled-waiting-list').getByRole('button', { name: 'Jump', exact: true }).click();
	await until(async () => (await proof()).length === 4 && await win.locator('.outscaled-workspace-name').innerText() === 'agents-demo', 'needs-you cross-workspace focus');
	await until(async () => await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id')) === target.id, 'waiting pane receives focus');
	const needsInput = await proof(); assert.notEqual(needsInput[0].dot, working[0].dot);
	assert.equal(await win.locator('.outscaled-agent-pane').first().evaluate((pane: Element) => getComputedStyle(pane).borderColor === getComputedStyle(pane.querySelector('.outscaled-status-dot')!).backgroundColor), true);
	await capture('05-needs-you-focused');
	await row('agents-demo').locator('.outscaled-workspace-dot').nth(2).click();
	await until(async () => await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id')) === terminals[2].id, 'sidebar dot focuses third agent');
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
	// Both workspaces remember Code mode. The same global bindings override group focus.
	await shortcut(2, 'second-demo'); await command('outscaled.agents.mode', 'code');
	await shortcut(1, 'agents-demo');
	assert.equal(await win.locator('.outscaled-title-controls button[aria-pressed="true"]').innerText(), 'Code');
	await shortcut(2, 'second-demo');
	assert.equal(await win.locator('.outscaled-title-controls button[aria-pressed="true"]').innerText(), 'Code');
	await capture('07a-code-shortcuts');
	await command('outscaled.agents.mode', 'agents');
	await shortcut(1, 'agents-demo');
	await win.locator('.sidebar .explorer-viewlet').waitFor();
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
	// Phase 4 item 7: daemon attribution, native diffs, Git API commit and Code navigation.
	await command('outscaled.agents.mode', 'agents');
	const changeGrid = await proof();
	const changeFocus = await win.evaluate(() => (window as ProbedWindow).__agentsProbe.agents.owners.get((window as ProbedWindow).__agentsProbe.agents.snapshot.workspaces.find(workspace => workspace.selected)!.id)?.active);
	const claudeChanges = terminals.find((terminal: any) => terminal.name === 'claude-1');
	const codexChanges = terminals.find((terminal: any) => terminal.name === 'codex-1');
	await request('workspaces/agents-demo/terminals/claude-1/input', { text: 'EDIT_CHANGES' });
	await until(async () => (await request('workspaces/agents-demo/changes')).files.some((file: any) => file.path === 'README.md' && file.agents.some((agent: any) => agent.terminal === 'claude-1')), 'Claude PostToolUse attribution');
	await request('hooks/codex', { terminal: codexChanges.id, payload: { type: 'agent-turn-complete' } });
	await request('workspaces/agents-demo/terminals/codex-1/input', { text: 'EDIT_CHANGES' });
	const changesButton = win.locator('.outscaled-changes-button');
	await until(async () => await changesButton.innerText() === 'Changes 2', 'live Changes count');
	await changesButton.click();
	const drawer = win.locator('.outscaled-changes-drawer'); await drawer.waitFor();
	const claudeRow = drawer.locator('.outscaled-change-row[data-path="README.md"]');
	const codexRow = drawer.locator('.outscaled-change-row[data-path="codex-change.ts"]');
	await until(async () => (await codexRow.innerText()).includes('codex-1 (approximate)'), 'Codex turn attribution reaches drawer');
	assert.deepEqual(await drawer.locator('.outscaled-change-path').allTextContents(), ['codex-change.ts', 'README.md']);
	assert.match(await claudeRow.innerText(), /Modified[\s\S]*claude-1/);
	assert.match(await codexRow.innerText(), /Untracked[\s\S]*codex-1 \(approximate\)/);
	await codexRow.locator('.approximate').hover();
	await win.locator('.monaco-hover').filter({ hasText: 'Concurrent agents' }).waitFor();
	await claudeRow.click();
	await drawer.locator('.outscaled-changes-diff .view-line').filter({ hasText: 'Claude edit from fake tool.' }).waitFor();
	assert.equal(await drawer.getByRole('button', { name: 'Commit', exact: true }).isDisabled(), true);
	await capture('changes-drawer-diff');
	await win.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' });
	await until(async () => await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id')) === changeFocus, 'drawer restores terminal focus');
	await changesButton.click(); await claudeRow.focus();
	await win.keyboard.press('ArrowUp'); await win.keyboard.press('Enter');
	await until(async () => await codexRow.getAttribute('aria-selected') === 'true', 'arrow and Enter select diff');
	await drawer.locator('.outscaled-changes-diff .view-line').filter({ hasText: 'export const codexChange = true;' }).waitFor();
	await claudeRow.click();
	await drawer.getByRole('button', { name: 'Open in Editor', exact: true }).click();
	await drawer.waitFor({ state: 'detached' });
	await until(async () => await win.evaluate(() => (window as ProbedWindow).__agentsProbe.agents.mode === 'code'), 'Open in Editor selects Code');
	await win.locator('.part.editor .monaco-diff-editor').waitFor();
	await win.locator('.tabs-container .tab:visible').filter({ hasText: 'README.md (Changes)' }).waitFor();
	const switcher = win.locator('.outscaled-code-switcher'); await switcher.waitFor();
	await switcher.getByRole('button', { name: 'Search', exact: true }).click(); await win.locator('.sidebar .search-view').waitFor();
	await switcher.getByRole('button', { name: 'Source Control', exact: true }).click(); await win.locator('.sidebar .scm-view').first().waitFor();
	await switcher.getByRole('button', { name: 'Explorer', exact: true }).click(); await win.locator('.sidebar .explorer-viewlet').waitFor();
	await command('workbench.action.toggleSidebarVisibility');
	await switcher.waitFor();
	await switcher.getByRole('button', { name: 'Explorer', exact: true }).click();
	await win.locator('.sidebar .explorer-viewlet').waitFor();
	await switcher.getByRole('button', { name: 'Explorer', exact: true }).hover();
	await win.locator('.monaco-hover').filter({ hasText: 'Explorer (' }).waitFor();
	assert.deepEqual(await win.locator('.outscaled-rail-agent strong').allTextContents(), ['claude-1', 'claude-2', 'codex-1', 'codex-2']);
	await request('hooks/claude-code', { terminal: claudeChanges.id, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } });
	const railAgent = win.locator(`.outscaled-rail-agent[data-terminal-id="${claudeChanges.id}"]`);
	await until(async () => await railAgent.getAttribute('data-status') === 'needs_input', 'live rail status dot');
	assert.equal(await railAgent.locator('.outscaled-status-dot').evaluate(element => getComputedStyle(element).backgroundColor), needsInput[0].dot);
	await command('notifications.clearAll'); await win.mouse.move(1000, 70);
	await until(async () => await win.locator('.monaco-hover:visible').count() === 0, 'hover settles before Code capture');
	await capture('code-switcher-rail');
	await railAgent.click();
	await until(async () => (await proof()).length === 4 && await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id')) === claudeChanges.id, 'rail returns to focused agent');
	assert.deepEqual((await proof()).map(pane => [pane.id, pane.width, pane.height]), changeGrid.map(pane => [pane.id, pane.width, pane.height]));
	assert.equal(await win.locator('.outscaled-code-switcher').isVisible(), false);
	assert.equal(await win.locator('.outscaled-agents-rail').isVisible(), false);
	await changesButton.click();
	await drawer.getByLabel('Commit Message', { exact: true }).fill('Commit fixture agent changes');
	assert.equal(await drawer.getByRole('button', { name: 'Commit', exact: true }).isDisabled(), false);
	const failingHook = join(folder, '.git/hooks/pre-commit');
	writeFileSync(failingHook, `#!/bin/sh\nprintf 'FIXTURE_COMMIT_REJECTED\\n' >&2\nexit 1\n`, { mode: 0o755 });
	await drawer.getByRole('button', { name: 'Commit', exact: true }).click();
	await until(async () => (await drawer.locator('footer .outscaled-changes-error').innerText()).includes('FIXTURE_COMMIT_REJECTED') && !await drawer.getByRole('button', { name: 'Commit', exact: true }).isDisabled(), 'Git commit failure is shown and retry enabled');
	assert.equal(git('log', '-1', '--format=%s'), 'Fixture baseline'); rmSync(failingHook);
	await drawer.getByRole('button', { name: 'Commit', exact: true }).click();
	await until(async () => await changesButton.innerText() === 'Changes', 'Changes count clears after commit');
	assert.equal(git('log', '-1', '--format=%s'), 'Commit fixture agent changes');
	assert.deepEqual(git('show', '--format=', '--name-only', 'HEAD').split('\n').sort(), ['README.md', 'codex-change.ts']);
	assert.equal(git('status', '--porcelain'), '');
	await drawer.getByText('No Changed Files', { exact: true }).waitFor();
	assert.equal(await drawer.getByRole('button', { name: 'Commit', exact: true }).isDisabled(), true);
	await capture('changes-empty'); await win.keyboard.press('Escape');
	await request('hooks/claude-code', { terminal: claudeChanges.id, payload: { hook_event_name: 'Stop' } });
	// Restore the original focus expected by the terminal identity/history checks below.
	await command('_outscaled.agents.request', { version: 1, action: 'focus', workspace: JSON.stringify(['local', 'agents-demo']), terminal: changeFocus });
	await command('outscaled.agents.mode', 'code');
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
	await installProbe();
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
			if (boxes.length !== count || !(await win.locator('.outscaled-agent-pane .outscaled-runtime-badge').allTextContents()).every((text: string) => text === 'Shell')) { return false; }
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
	// Phase 4 item 2: the modal creates fresh agents; legacy openGrid above still
	// verifies all pre-existing client lifetime, geometry and transport behavior.
	const dialog = win.getByRole('dialog', { name: 'New Agents', exact: true });
	const openDialog = async () => {
		await win.locator('.outscaled-title-controls').getByRole('button', { name: 'New agents', exact: true }).click();
		await dialog.waitFor();
		await dialog.getByRole('button', { name: '2 Claude + 2 Codex', exact: true }).waitFor();
	};
	const create = async () => { await dialog.getByRole('button', { name: 'Create', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); };
	await win.locator('.outscaled-agent-pane').nth(1).locator('.xterm-helper-textarea').focus();
	const priorFocus = await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id'));
	await win.keyboard.press('Meta+n'); await dialog.waitFor();
	assert.equal(await dialog.getByLabel('Type What You Want', { exact: true }).evaluate(input => input === document.activeElement), true);
	await capture('new-00-empty');
	await win.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
	assert.equal(await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id')), priorFocus);
	await command('outscaled.agents.mode', 'code');
	await win.keyboard.press('Meta+n'); await dialog.waitFor();
	await win.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
	await until(async () => await win.evaluate(() => (window as ProbedWindow).__agentsProbe.agents.mode === 'code'), 'cancel restores Code mode');
	await command('outscaled.agents.mode', 'agents');
	await openDialog();
	await dialog.getByRole('button', { name: '2 Claude + 2 Codex', exact: true }).click(); await capture('new-01-preset'); await create();
	await until(async () => (await proof()).length === 4 && (await proof()).every(pane => pane.text?.includes('AGENTS_VIEW')), 'new preset grid');
	await until(async () => await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id')) === (await proof())[0].id, 'first new pane receives focus');
	await capture('new-02-preset-grid');
	for (const [typed, expected] of [
		['2x2 claude', { layout: '2×2', agents: ['claude', 'claude', 'claude', 'claude'], run: 'quick', where: 'replace' }],
		['codex right', { layout: 'Single', agents: ['codex'], run: 'quick', where: 'right' }],
		['claude every 30m', { layout: 'Single', agents: ['claude'], run: 'scheduled', where: 'replace' }]
	] as const) {
		await openDialog(); await dialog.getByLabel('Type What You Want', { exact: true }).fill(typed);
		assert.equal(await dialog.getByRole('button', { name: expected.layout, exact: true }).getAttribute('aria-pressed'), 'true');
		assert.deepEqual(await dialog.locator('.outscaled-launch-pane select').evaluateAll(selects => selects.map(select => (select as HTMLSelectElement).value)), [...expected.agents]);
		assert.equal(await dialog.getByLabel('Runs', { exact: true }).inputValue(), expected.run);
		assert.equal(await dialog.getByLabel('Where', { exact: true }).inputValue(), expected.where);
		if (expected.run === 'scheduled') {
			assert.equal(await dialog.getByLabel('Interval', { exact: true }).inputValue(), '30m');
			assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
			await dialog.getByText('Scheduled agents go to the background strip.', { exact: false }).waitFor();
			assert.equal(await dialog.getByLabel('Where', { exact: true }).isDisabled(), true);
			await dialog.getByLabel('Prompt (Required for Scheduled)', { exact: true }).fill('SCHEDULE_FIXTURE');
			assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).isEnabled(), true);
			await capture('dialog-scheduled');
			await dialog.getByLabel('Prompt (Required for Scheduled)', { exact: true }).fill('');
			const before = await request('workspaces/agents-demo/terminals');
			await win.keyboard.press('Enter');
			assert.deepEqual((await request('workspaces/agents-demo/terminals')).map(terminal => terminal.id), before.map(terminal => terminal.id));
		}
		await capture('new-typed-' + typed.replaceAll(' ', '-'));
		await win.keyboard.press('Escape');
	}
	const replaced = await proof();
	const runningBefore = await request('workspaces/agents-demo/terminals');
	await openDialog(); await dialog.getByRole('button', { name: '1 Claude + shell', exact: true }).click(); await create();
	await until(async () => (await proof()).length === 2, 'replacement grid');
	assert.ok((await proof()).every(pane => !replaced.some(old => old.id === pane.id)));
	for (const terminal of runningBefore) {
		assert.equal(spawnSync('tmux', ['-S', socket, 'has-session', '-t', '=' + terminal.session]).status, 0);
	}
	for (const pane of replaced) { await win.locator(`.outscaled-background-chip[data-terminal-id="${pane.id}"]`).waitFor(); }
	await capture('strip-chips');
	await capture('new-03-replace-grid');
	const literalPrompt = 'Say "hello" and \'goodbye\': $(touch pwned) `touch pwned`\nnext line';
	await openDialog(); await dialog.getByLabel('Type What You Want', { exact: true }).fill('codex right');
	const anchor = await win.evaluate(() => (window as ProbedWindow).__agentsProbe.agents.owners.get((window as ProbedWindow).__agentsProbe.agents.snapshot.workspaces.find(workspace => workspace.selected)!.id)?.active);
	const beforeRight = await proof();
	await dialog.getByLabel('First Prompt (Optional)', { exact: true }).fill(literalPrompt); await create();
	await until(async () => (await proof()).length === 3 && (await proof()).every(pane => pane.text?.includes('AGENTS_VIEW') || !pane.text?.includes('fake')), 'right grid');
	await until(() => readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).some(entry => entry.agent === 'codex' && entry.args.at(-1) === literalPrompt), 'prompt delivered literally');
	assert.equal(existsSync(join(folder, 'pwned')), false);
	const rightGrid = await proof(); const anchorBox = rightGrid.find(pane => pane.id === anchor)!;
	const newRight = rightGrid.find(pane => !beforeRight.some(old => old.id === pane.id))!;
	assert.ok(newRight.x > anchorBox.x && newRight.y === anchorBox.y);
	await capture('new-04-right-grid');
	await openDialog(); await dialog.getByLabel('Type What You Want', { exact: true }).fill('side by side shell add'); await create();
	await until(async () => (await proof()).length === 5, 'add grid');
	const added = await proof();
	assert.ok(added.slice(3).every(pane => pane.x >= Math.max(...added.slice(0, 3).map(old => old.x + old.width))));
	await capture('new-05-add-grid');
	await openDialog(); await dialog.getByLabel('Type What You Want', { exact: true }).fill('claude always');
	await dialog.getByLabel('Preset Name', { exact: true }).fill('My always-on Claude');
	await dialog.getByRole('button', { name: 'Save as Preset', exact: true }).click();
	await dialog.getByText('Preset saved for this workspace.', { exact: true }).waitFor();
	assert.ok(readFileSync(join(config, 'presets.toml'), 'utf8').includes('My always-on Claude'));
	await create(); await until(async () => (await proof()).length === 1, 'always on grid');
	const alwaysId = (await proof())[0].id;
	assert.equal((await request('workspaces/agents-demo/terminals')).find(terminal => terminal.id === alwaysId).alwaysOn, true);
	await capture('new-06-always-grid');
	await command('workbench.action.reloadWindow').catch(() => {});
	await win.waitForFunction(() => !(window as ProbedWindow).__agentsProbe);
	await until(async () => (await proof()).length === 1 && (await proof())[0].id === alwaysId, 'replacement membership survives reload', 60000);
	await installProbe();
	assert.ok((await proof()).every(pane => !replaced.some(old => old.id === pane.id)));
	for (const terminal of runningBefore) { assert.equal(spawnSync('tmux', ['-S', socket, 'has-session', '-t', '=' + terminal.session]).status, 0); }
	await openDialog(); await dialog.getByRole('button', { name: 'My always-on Claude', exact: true }).waitFor();
	await capture('new-07-saved-after-reload'); await win.keyboard.press('Escape');
	for (const pane of replaced) { await win.locator(`.outscaled-background-chip[data-terminal-id="${pane.id}"]`).waitFor(); }
	await capture('new-08-grid-after-reload');
	assert.equal(await row('agents-demo').locator('.outscaled-workspace-dot').count(), (await request('workspaces/agents-demo/terminals')).length);

	// Phase 4 item 3: pane menus, scoped shortcuts, background membership and nested sashes.
	const focusedId = () => win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id'));
	const paneById = (id: string) => win.locator(`.outscaled-agent-pane[data-terminal-id="${id}"]`);
	const paneFocus = async (id: string) => {
		await paneById(id).locator('.xterm-helper-textarea').focus();
		await until(async () => await focusedId() === id && await win.evaluate(id => {
			const agents = (window as ProbedWindow).__agentsProbe.agents;
			const workspace = agents.snapshot.workspaces.find(workspace => workspace.selected);
			return agents.mode === 'agents' && !!workspace && agents.owners.get(workspace.id)?.active === id;
		}, id), 'native terminal and pane focus agree');
	};
	const daemonBeforeActions = await request('workspaces/agents-demo/terminals');
	await paneFocus(alwaysId);
	await win.keyboard.press('F1'); await win.locator('.quick-input-widget input').fill('>Add Claude to the Right');
	await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Add Claude to the Right' }).waitFor();
	await capture('pane-00-command-palette'); await win.keyboard.press('Escape');
	await paneFocus(alwaysId);
	await win.keyboard.press('Meta+d');
	await until(async () => (await proof()).length === 2 && await focusedId() !== alwaysId, 'Cmd+D adds and focuses Claude');
	const claudeId = (await focusedId())!;
	const afterClaude = await proof();
	assert.ok(afterClaude[1].x > afterClaude[0].x && afterClaude[1].y === afterClaude[0].y);
	assert.equal(await paneById(claudeId).locator('.outscaled-runtime-badge').innerText(), 'Claude');
	await capture('pane-01-shortcut-claude-right');
	await win.keyboard.press('Shift+Alt+Meta+d');
	await until(async () => (await proof()).length === 3 && await focusedId() !== claudeId, 'Shift+Alt+Cmd+D adds and focuses Codex below');
	const codexId = (await focusedId())!;
	const afterCodex = await proof();
	assert.ok(afterCodex[2].y > afterCodex[1].y && afterCodex[2].x === afterCodex[1].x);
	assert.equal(await paneById(codexId).locator('.outscaled-runtime-badge').innerText(), 'Codex');
	const daemonAfterShortcuts = await request('workspaces/agents-demo/terminals');
	assert.equal(daemonAfterShortcuts.length, daemonBeforeActions.length + 2);
	assert.ok([claudeId, codexId].every(id => !daemonBeforeActions.some(terminal => terminal.id === id)));
	await capture('pane-02-shortcut-codex-below');
	const menuLabels = ['Add Claude to the Right', 'Add Codex to the Right', 'Add Shell to the Right', 'Add Claude Below', 'Add Codex Below', 'Add Shell Below', 'Move to Background'];
	await paneById(codexId).getByRole('button', { name: 'Pane Actions', exact: true }).click();
	for (const label of menuLabels) { await win.getByRole('menuitem', { name: label, exact: false }).waitFor(); }
	await capture('pane-03-open-menu');
	await win.getByRole('menuitem', { name: 'Add Shell to the Right', exact: true }).click();
	await until(async () => (await proof()).length === 4 && await focusedId() !== codexId, 'header menu adds and focuses a shell');
	const shellId = (await focusedId())!;
	assert.equal(await paneById(shellId).locator('.outscaled-runtime-badge').innerText(), 'Shell');
	await capture('pane-04-menu-shell-right');
	await win.keyboard.press('Meta+m');
	await until(async () => (await proof()).length === 3 && await focusedId() === codexId, 'Cmd+M removes pane and focuses nearest neighbour');
	const shellSession = (await request('workspaces/agents-demo/terminals')).find(terminal => terminal.id === shellId);
	assert.equal(spawnSync('tmux', ['-S', socket, 'has-session', '-t', '=' + shellSession.session]).status, 0);
	const closedGap = await proof();
	assert.ok(Math.abs(closedGap[1].width - closedGap[2].width) < 2);
	await win.locator(`.outscaled-background-chip[data-terminal-id="${shellId}"]`).waitFor();
	await request(`workspaces/agents-demo/terminals/${shellSession.name}/input`, { text: 'echo STRIP_LIVE_OUTPUT; sleep 10', submit: true });
	await until(async () => (await win.locator(`.outscaled-background-chip[data-terminal-id="${shellId}"] .outscaled-background-line`).innerText()) === 'STRIP_LIVE_OUTPUT', 'shell chip latest line');
	await capture('pane-05-background-closes-gap');
	// All these trees use the pre-resize format: no sizes at any split level.
	assert.equal(await win.evaluate(() => JSON.stringify((window as ProbedWindow).__agentsProbe.agents.snapshot.workspaces.find(workspace => workspace.selected)!.layout).includes('sizes')), false);
	const reloadAgents = async () => {
		await command('workbench.action.reloadWindow').catch(() => {});
		await win.waitForFunction(() => !(window as ProbedWindow).__agentsProbe);
		await until(async () => (await proof()).length === 3, 'three panes restored after reload', 60000);
		await installProbe();
	};
	await reloadAgents();
	assert.deepEqual((await proof()).map(pane => pane.id), [alwaysId, claudeId, codexId]);
	assert.equal(spawnSync('tmux', ['-S', socket, 'has-session', '-t', '=' + shellSession.session]).status, 0);
	await win.locator(`.outscaled-background-chip[data-terminal-id="${shellId}"]`).waitFor();
	await capture('pane-06-old-layout-and-background-reloaded');
	const dimensions = () => win.evaluate(() => {
		const probe = (window as ProbedWindow).__agentsProbe;
		const workspace = probe.agents.snapshot.workspaces.find(workspace => workspace.selected)!;
		return [...probe.agents.owners.get(workspace.id)!.panes].map(([id, pane]) => ({ id, cols: pane.instance.cols, rows: pane.instance.rows }));
	});
	const dragSash = async (selector: string, dx: number, dy: number, name: string) => {
		const sash = win.locator(selector).first();
		const box = (await sash.boundingBox())!;
		const x = box.x + box.width / 2, y = box.y + box.height / 2;
		await win.mouse.move(x, y); await win.mouse.down();
		await win.mouse.move(x + dx, y + dy, { steps: 12 });
		await capture(name); await win.mouse.up();
	};
	const rootSash = '.outscaled-agents-grid > .outscaled-agents-split > .monaco-sash.vertical';
	const nestedSash = '.outscaled-agents-grid .monaco-sash.horizontal';
	const beforeResize = await dimensions();
	await dragSash(rootSash, 100, 0, 'pane-07-mid-resize-right');
	await until(async () => (await dimensions()).find(pane => pane.id === alwaysId)!.cols !== beforeResize.find(pane => pane.id === alwaysId)!.cols, 'terminal columns follow horizontal resize');
	await dragSash(nestedSash, 0, 60, 'pane-08-mid-resize-below');
	await until(async () => (await dimensions()).find(pane => pane.id === claudeId)!.rows !== beforeResize.find(pane => pane.id === claudeId)!.rows, 'terminal rows follow vertical resize');
	await until(async () => await win.evaluate(() => {
		const layout = (window as ProbedWindow).__agentsProbe.agents.snapshot.workspaces.find(workspace => workspace.selected)!.layout;
		return layout.type === 'split' && !!layout.sizes && layout.children[1].type === 'split' && !!layout.children[1].sizes;
	}), 'both split weights persisted');
	const resized = await proof();
	await capture('pane-09-resized');
	await reloadAgents();
	const reloadedSizes = await proof();
	assert.ok(reloadedSizes.every((pane, index) => Math.abs(pane.width - resized[index].width) < 3 && Math.abs(pane.height - resized[index].height) < 3));
	await capture('pane-10-resized-reloaded');
	await win.locator(rootSash).dblclick();
	await win.locator(nestedSash).first().dblclick();
	await until(async () => {
		const boxes = await proof();
		return Math.abs(boxes[0].width - boxes[1].width) < 2 && Math.abs(boxes[1].height - boxes[2].height) < 2;
	}, 'double-click equalizes both levels');
	await capture('pane-11-even-splits');
	// Mouse actions target the clicked pane, independently of the previous active pane.
	await paneFocus(codexId);
	await paneById(alwaysId).getByRole('button', { name: 'Pane Actions', exact: true }).click();
	await win.getByRole('menuitem', { name: 'Add Claude to the Right', exact: false }).click();
	await until(async () => (await proof()).length === 4 && ![alwaysId, claudeId, codexId].includes((await focusedId())!), 'mouse adds Claude right of the chosen pane');
	const mouseClaude = (await focusedId())!;
	await capture('pane-12-menu-claude-right');
	await paneById(mouseClaude).getByRole('button', { name: 'Pane Actions', exact: true }).click();
	await win.getByRole('menuitem', { name: 'Add Codex Below', exact: false }).click();
	await until(async () => (await proof()).length === 5 && await focusedId() !== mouseClaude, 'mouse adds Codex below');
	await capture('pane-13-menu-codex-below');
	// The terminal context menu contributes the same native submenu.
	await paneById(mouseClaude).locator('.outscaled-agent-header').click({ button: 'right' });
	await win.getByRole('menuitem', { name: 'Pane Actions', exact: false }).waitFor();
	await capture('pane-14-terminal-context-menu'); await win.keyboard.press('Escape');
	for (const [binding, runtime] of [['Alt+Meta+d', 'Codex'], ['Shift+Meta+d', 'Claude']] as const) {
		const before = await proof();
		await paneFocus(codexId); await win.keyboard.press(binding);
		await until(async () => (await proof()).length === before.length + 1 && await focusedId() !== codexId, binding);
		assert.equal(await paneById((await focusedId())!).locator('.outscaled-runtime-badge').innerText(), runtime);
		await capture('pane-shortcut-' + runtime.toLowerCase());
	}

	// Editors retain their native Cmd+D binding and never create a daemon terminal.
	const beforeEditor = await request('workspaces/agents-demo/terminals');
	writeFileSync(join(folder, 'matches.txt'), 'match match match\n');
	await command('outscaled.agents.mode', 'code');
	await win.evaluate(resource => (window as ProbedWindow).__agentsProbe.openFile(resource), pathToFileURL(join(folder, 'matches.txt')).href);
	await command('cursorTop'); await win.keyboard.press('Meta+d'); await win.keyboard.press('Meta+d');
	assert.equal(await win.evaluate(() => (window as ProbedWindow).__agentsProbe.selectionCount()), 2);
	assert.deepEqual((await request('workspaces/agents-demo/terminals')).map(terminal => terminal.id), beforeEditor.map(terminal => terminal.id));
	await capture('pane-15-code-native-cmd-d');
	await command('outscaled.agents.mode', 'agents');
	// Moving every remaining pane out reaches the empty-grid state, preserving tmux.
	while ((await proof()).length) {
		const id = (await proof())[0].id!;
		await paneFocus(id);
		if (id === alwaysId) {
			await paneById(id).getByRole('button', { name: 'Pane Actions', exact: true }).click();
			await win.getByRole('menuitem', { name: 'Move to Background', exact: false }).click();
		} else { await win.keyboard.press('Meta+m'); }
		await until(async () => !(await proof()).some(pane => pane.id === id), 'background next pane');
		await capture('pane-background-remaining-' + (await proof()).length);
	}
	await win.getByText('Choose New agents to open a terminal grid.', { exact: true }).waitFor();
	await capture('pane-16-empty-grid');
	for (const terminal of beforeEditor) { assert.equal(spawnSync('tmux', ['-S', socket, 'has-session', '-t', '=' + terminal.session]).status, 0); }
	await command('workbench.action.reloadWindow').catch(() => {});
	await win.waitForFunction(() => !(window as ProbedWindow).__agentsProbe);
	await win.getByText('Choose New agents to open a terminal grid.', { exact: true }).waitFor();
	await installProbe();
	assert.equal((await proof()).length, 0);
	await capture('pane-17-empty-reloaded');


	// Background chips retain live data, keyboard focus and scroll under stream updates.
	const chipFor = (id: string) => win.locator(`.outscaled-background-chip[data-terminal-id="${id}"]`);
	await chipFor(shellId).click();
	const card = win.locator('.outscaled-agent-card'); await card.waitFor(); await capture('agent-card');
	await card.getByRole('button', { name: 'Open in Grid', exact: true }).click();
	await until(async () => (await proof()).length === 1 && await focusedId() === shellId, 'chip opens into empty grid focused');
	assert.equal(await chipFor(shellId).count(), 0);
	// Reopen an ordinary chip relative to the focused pane.
	await chipFor(claudeId).click(); await card.getByRole('button', { name: 'Open in Grid', exact: true }).click();
	await until(async () => (await proof()).length === 2 && await focusedId() === claudeId, 'chip opens to right focused');
	assert.deepEqual((await proof()).map(pane => pane.id), [shellId, claudeId]);
	await win.keyboard.press('Meta+m'); await chipFor(claudeId).waitFor();
	const transcript = join(temporary, 'strip-transcript.jsonl');
	writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'TRANSCRIPT_LATEST_LINE' }] } }) + '\n');
	await request('hooks/claude-code', { terminal: claudeId, payload: { hook_event_name: 'Stop', transcript_path: transcript } });
	await until(async () => (await chipFor(claudeId).locator('.outscaled-background-line').innerText()) === 'TRANSCRIPT_LATEST_LINE', 'Claude transcript chip line');
	await request('hooks/claude-code', { terminal: claudeId, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } });
	await until(async () => await chipFor(claudeId).getAttribute('data-status') === 'needs_input', 'chip needs-you dot');
	await command('notifications.clearAll');
	await chipFor(claudeId).focus(); await win.keyboard.press('ArrowRight');
	assert.notEqual(await win.evaluate(() => document.activeElement?.getAttribute('data-terminal-id')), claudeId);
	await win.keyboard.press('Enter'); await card.waitFor(); await win.keyboard.press('Escape');
	assert.equal(await card.count(), 0);
	await win.locator('.outscaled-background-list').evaluate(element => { element.scrollLeft = 0; });
	assert.equal(await win.locator('.outscaled-background-list').evaluate(element => element.scrollWidth > element.clientWidth), true);
	await capture('strip-overflow');

	const schedulesPath = 'workspaces/agents-demo/schedules';
	await openDialog(); await dialog.getByLabel('Type What You Want', { exact: true }).fill('claude every 30m');
	await dialog.getByLabel('Prompt (Required for Scheduled)', { exact: true }).fill('SCHEDULE_FIXTURE'); await create();
	await until(async () => (await request(schedulesPath)).length === 1, 'schedule created');
	const schedule = (await request(schedulesPath))[0];
	const scheduleChip = win.locator(`.outscaled-background-chip[data-agent-id="schedule:${schedule.name}"]`);
	await scheduleChip.waitFor(); assert.match(await scheduleChip.innerText(), /Next:/);
	await command('notifications.clearAll');
	const savedLayout = () => win.evaluate(() => (window as ProbedWindow).__agentsProbe.agents.snapshot.workspaces.find(workspace => workspace.selected)!.layout);
	const scheduledLayout = await savedLayout();
	await command('outscaled.agents.mode', 'code');
	await win.locator(`.outscaled-rail-agent[data-agent-id="schedule:${schedule.name}"]`).click();
	await card.waitFor();
	assert.deepEqual(await savedLayout(), scheduledLayout, 'unstarted schedule rail card preserves grid');
	await win.keyboard.press('Escape');
	await command('outscaled.agents.mode', 'code');
	await win.locator(`.outscaled-rail-agent[data-terminal-id="${claudeId}"]`).click();
	await card.waitFor();
	await card.getByText('TRANSCRIPT_LATEST_LINE', { exact: true }).waitFor();
	assert.deepEqual(await savedLayout(), scheduledLayout, 'background terminal rail card preserves grid');
	await win.keyboard.press('Escape');
	await scheduleChip.click(); await card.waitFor();
	assert.equal(await card.getByRole('button', { name: 'Open in Grid', exact: true }).isDisabled(), true);
	await card.getByText('A terminal is available after the first run.', { exact: true }).waitFor();
	await until(async () => await card.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight; }), 'scheduled card stays inside viewport');
	await capture('scheduled-card');
	await card.getByRole('button', { name: 'Run Now', exact: true }).click();
	await until(async () => await scheduleChip.getAttribute('data-status') === 'working', 'schedule run working');
	assert.equal(await card.getByRole('button', { name: 'Run Now', exact: true }).isDisabled(), true);
	await card.getByText('A run is already in progress.', { exact: true }).waitFor();
	await until(async () => (await request('workspaces/agents-demo/terminals')).some(terminal => terminal.name === schedule.name), 'scheduled terminal exists');
	const scheduledTerminal = (await request('workspaces/agents-demo/terminals')).find(terminal => terminal.name === schedule.name);
	await until(async () => (await request(`workspaces/agents-demo/terminals/${scheduledTerminal.name}/output`)).text.includes('SCHEDULE_RESULT'), 'fake scheduled output');
	writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SCHEDULE_RESULT' }] } }) + '\n');
	await request('hooks/claude-code', { terminal: scheduledTerminal.id, payload: { hook_event_name: 'Stop', transcript_path: transcript } });
	await until(async () => (await scheduleChip.locator('.outscaled-background-line').innerText()) === 'SCHEDULE_RESULT' && (await card.innerText()).includes('Succeeded'), 'completed run and latest line');
	await capture('scheduled-card-completed');
	await card.getByRole('button', { name: 'Pause', exact: true }).click();
	await card.getByRole('button', { name: 'Resume', exact: true }).waitFor(); assert.equal((await request(schedulesPath))[0].paused, true);
	await card.getByRole('button', { name: 'Resume', exact: true }).click();
	await card.getByRole('button', { name: 'Pause', exact: true }).waitFor(); assert.equal((await request(schedulesPath))[0].paused, false);
	await card.getByRole('button', { name: 'Edit', exact: true }).click();
	await until(async () => await card.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight; }), 'schedule edit stays inside viewport');
	await capture('scheduled-card-edit');
	await card.getByLabel('Prompt (Required)', { exact: true }).fill('Edited schedule prompt');
	await card.getByLabel('Interval', { exact: true }).fill('2h');
	await card.getByRole('button', { name: 'Save', exact: true }).click();
	await until(async () => (await request(schedulesPath))[0].every === '2h', 'schedule edit saved');
	assert.equal((await request(schedulesPath))[0].prompt, 'Edited schedule prompt');
	await card.getByRole('button', { name: 'Open in Grid', exact: true }).click();
	await until(async () => await focusedId() === scheduledTerminal.id && (await proof()).length === 2, 'scheduled terminal opens focused');
	assert.equal(await scheduleChip.count(), 0);
	await win.keyboard.press('Meta+m'); await scheduleChip.waitFor();
	mkdirSync(join(folder, '.ws'), { recursive: true });
	writeFileSync(join(folder, '.ws/prompt.md'), 'Workspace schedule prompt');
	writeFileSync(join(folder, '.ws/workspace.toml'), '[[agent]]\nname = "workspace-check"\nruntime = "codex"\nmode = "scheduled"\nevery = "1d"\nprompt = "prompt.md"\n');
	await scheduleChip.click(); await card.getByRole('button', { name: 'Delete', exact: true }).click();
	const confirmation = win.locator('.monaco-dialog-box'); await confirmation.waitFor();
	await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
	await until(async () => !(await request(schedulesPath)).some(entry => entry.name === schedule.name) && await scheduleChip.count() === 0, 'schedule deleted');
	// Workspace schedules retain pause/run controls but direct edits to workspace.toml.

	const workspaceChip = win.locator('.outscaled-background-chip[data-agent-id="schedule:workspace-check"]'); await workspaceChip.waitFor(); await workspaceChip.click();
	await card.getByText('Edit this schedule in .ws/workspace.toml.', { exact: true }).waitFor();
	assert.equal(await card.getByRole('button', { name: 'Edit', exact: true }).isVisible(), false);
	assert.equal(await card.getByRole('button', { name: 'Delete', exact: true }).isVisible(), false);
	await capture('scheduled-card-workspace'); await win.keyboard.press('Escape');

	// Needs-you permissions use real redacted screens and the daemon's screen guard.
	await switchWorkspace('agents-demo');
	await command('notifications.clearAll');
	const permissionRows = () => readFileSync(permissionReport, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	const drawPermission = async (terminal: { id: string; name: string; workspace: string }, screen: 'edit' | 'bash') => {
		await request('hooks/claude-code', { terminal: terminal.id, payload: { hook_event_name: 'Stop' } });
		writeFileSync(join(permissionControl, terminal.id + '.json'), JSON.stringify({ screen, nonce: Date.now() }));
		await until(async () => !!(await request(`workspaces/${terminal.workspace}/terminals`)).find(entry => entry.id === terminal.id)?.request?.permission, 'permission captured from fake ' + screen);
		await until(async () => await win.evaluate(id => (window as ProbedWindow).__agentsProbe.agents.snapshot.workspaces.some(workspace => workspace.terminals.some(pane => pane.id === id && !!pane.request?.permission)), terminal.id), 'permission bridged');
		await command('notifications.clearAll');
	};
	const waitingList = win.locator('.outscaled-waiting-list');
	const waitingRow = (id: string) => waitingList.locator(`.outscaled-waiting-row[data-terminal-id="${id}"]`);
	const showWaiting = async () => { await win.locator('.outscaled-needs-you').click(); await waitingList.waitFor(); };
	// Remove old notification-only waits before asserting global order and count.
	for (const terminal of await request('terminals')) {
		if (terminal.runtime === 'claude-code') { await request('hooks/claude-code', { terminal: terminal.id, payload: { hook_event_name: 'Stop' } }); }
	}
	await chipFor(claudeId).click(); await card.getByRole('button', { name: 'Open in Grid', exact: true }).click();
	await until(async () => await focusedId() === claudeId, 'permission pane open');
	const editAgent = (await request('workspaces/agents-demo/terminals')).find(entry => entry.id === claudeId);
	const bashAgent = secondTerminals.find(entry => entry.runtime === 'claude-code');
	await drawPermission(editAgent, 'edit');
	await paneById(claudeId).locator('.outscaled-request-banner').getByText('Do you want to create notes.txt?', { exact: true }).waitFor();
	const semanticColors = await win.evaluate(id => {
		const pane = document.querySelector<HTMLElement>(`.outscaled-agent-pane[data-terminal-id="${id}"]`)!;
		const badge = document.querySelector('.outscaled-workspace-row[aria-selected="true"] .outscaled-workspace-badge')!;
		return [getComputedStyle(pane).borderColor, getComputedStyle(pane.querySelector('.outscaled-request-banner')!).color, getComputedStyle(badge).backgroundColor, getComputedStyle(document.querySelector('.outscaled-needs-you')!).color];
	}, claudeId);
	assert.ok(semanticColors.every(color => color === semanticColors[0]), 'needs-you uses one theme color');
	await capture('needs-you-pane-banner');
	await switchWorkspace('second-demo');
	await win.locator('.outscaled-agent-pane .xterm-helper-textarea').first().focus();
	await win.keyboard.press('Meta+j');
	await until(async () => await focusedId() === claudeId && await win.locator('.outscaled-workspace-name').innerText() === 'agents-demo', 'Cmd+J inside terminal crosses workspaces');
	await drawPermission(bashAgent, 'bash');
	await paneFocus(claudeId); await win.keyboard.press('Meta+j');
	await until(async () => await focusedId() === bashAgent.id, 'Cmd+J cycles to newer wait');
	await win.keyboard.press('Meta+j'); await until(async () => await focusedId() === claudeId, 'Cmd+J wraps to oldest wait');
	await win.locator('.outscaled-needs-you').getByText('2 need you', { exact: true }).waitFor();
	await showWaiting();
	assert.deepEqual(await waitingList.locator('.outscaled-waiting-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-terminal-id'))), [claudeId, bashAgent.id]);
	await win.keyboard.press('ArrowDown');
	assert.equal(await waitingRow(bashAgent.id).evaluate(row => row === document.activeElement), true);
	await win.keyboard.press('Escape'); await waitingList.waitFor({ state: 'detached' });
	await showWaiting(); await capture('needs-you-list');
	const selectedBeforeAnswer = await win.locator('.outscaled-workspace-name').innerText();
	await waitingRow(claudeId).getByRole('button', { name: 'Allow Once', exact: true }).click();
	await until(async () => await waitingRow(claudeId).count() === 0, 'Allow Once clears edit row');
	assert.equal(await win.locator('.outscaled-workspace-name').innerText(), selectedBeforeAnswer);
	assert.equal(await paneById(claudeId).locator('.outscaled-request-banner').isVisible(), false);
	await waitingRow(bashAgent.id).getByRole('button', { name: 'Deny', exact: true }).click();
	await waitingList.waitFor({ state: 'detached' });
	await until(() => permissionRows().some(row => row.terminal === claudeId && row.key === '1') && permissionRows().some(row => row.terminal === bashAgent.id && row.key === '4'), 'fake reports exact edit allow and Bash deny keys');
	assert.equal(await win.locator('.outscaled-workspace-name').innerText(), selectedBeforeAnswer, 'answering another workspace does not open it');
	await drawPermission(editAgent, 'edit');
	writeFileSync(join(permissionControl, claudeId + '.json'), JSON.stringify({ screen: 'clear', nonce: Date.now() }));
	await until(() => permissionRows().filter(row => row.terminal === claudeId && row.screen === 'clear').length === 1, 'fake clears permission without a status hook');
	const keysBeforeConflict = permissionRows().filter(row => row.key);
	await switchWorkspace('second-demo'); await showWaiting();
	await waitingRow(claudeId).getByRole('button', { name: 'Allow Once', exact: true }).click();
	await until(async () => await focusedId() === claudeId && await win.locator('.outscaled-workspace-name').innerText() === 'agents-demo', 'stale prompt jumps to the agent');
	await win.getByText('The permission prompt changed or is no longer on screen. Review the agent to continue.', { exact: true }).waitFor();
	assert.deepEqual(permissionRows().filter(row => row.key), keysBeforeConflict, '409 sends no key');
	await command('notifications.clearAll');
	await drawPermission(editAgent, 'edit');
	await paneFocus(claudeId); await win.keyboard.press('Meta+m'); await chipFor(claudeId).waitFor();
	const beforeJumpGrid = (await proof()).map(pane => pane.id);
	await switchWorkspace('second-demo');
	await win.locator('.outscaled-agent-pane .xterm-helper-textarea').first().focus(); await win.keyboard.press('Meta+j');
	await card.getByText('Do you want to create notes.txt?', { exact: true }).waitFor();
	await card.getByRole('button', { name: 'Allow Once', exact: true }).waitFor();
	await card.getByRole('button', { name: 'Deny', exact: true }).waitFor();
	assert.deepEqual((await proof()).map(pane => pane.id), beforeJumpGrid, 'jump opens the card without changing the grid');
	await capture('needs-you-background-card');
	await win.keyboard.press('Escape');
	writeFileSync(join(evidence, 'needs-you-proof.json'), JSON.stringify({ semanticColors, keys: permissionRows(), noKeyOnConflict: true, backgroundGridUnchanged: true }, null, 2));

	// Exercise the retained VPS transport through a private SSH double. Both endpoints
	// use this fixture daemon; no connection is made to port 7770 or a real host.
	await request('hooks/claude-code', { terminal: target.id, payload: { hook_event_name: 'Stop' } });
	const remoteFolder = join(temporary, 'remote-workspace'); mkdirSync(remoteFolder); writeFileSync(join(remoteFolder, 'README.md'), '# Remote workspace\n');
	gitAt(remoteFolder, 'init', '-q'); gitAt(remoteFolder, 'config', 'user.name', 'Fixture'); gitAt(remoteFolder, 'config', 'user.email', 'fixture@example.invalid');
	gitAt(remoteFolder, 'config', 'commit.gpgsign', 'false'); gitAt(remoteFolder, 'add', 'README.md'); gitAt(remoteFolder, 'commit', '-qm', 'Remote fixture baseline');
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
	const remoteRow = win.locator('.outscaled-workspace-row').filter({ has: win.locator('.outscaled-workspace-label', { hasText: 'vps-demo' }) }).filter({ hasText: 'example-alias' });
	assert.equal(await remoteRow.locator('.outscaled-workspace-dot').count(), 2);
	assert.equal(await remoteRow.locator('.outscaled-workspace-detail').innerText(), `example-alias · ${remoteFolder}`);
	await remoteRow.locator('.outscaled-workspace-dot').nth(1).click();
	await until(async () => await win.evaluate(() => document.activeElement?.closest('.outscaled-agent-pane')?.getAttribute('data-terminal-id')) === (await remoteRow.locator('.outscaled-workspace-dot').nth(1).getAttribute('data-terminal-id')), 'VPS dot focus');
	await capture('11-vps-agents');
	writeFileSync(join(remoteFolder, 'README.md'), '# Remote workspace\n\nRemote agent edit.\n');
	const remoteAgent = (await request('workspaces/vps-demo/terminals')).find((terminal: any) => terminal.runtime === 'claude-code');
	await request('hooks/claude-code', { terminal: remoteAgent.id, payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(remoteFolder, 'README.md') } } });
	await until(async () => await changesButton.innerText() === 'Changes 1', 'VPS Changes count');
	await changesButton.click(); await drawer.waitFor();
	await drawer.getByText('Diffs and Commit for VPS workspaces come later. Open in Editor opens the file.', { exact: true }).waitFor();
	assert.match(await drawer.locator('.outscaled-change-row').innerText(), /claude/);
	assert.equal(await drawer.getByRole('button', { name: 'Commit', exact: true }).isDisabled(), true);
	assert.equal(await drawer.locator('.outscaled-changes-diff .monaco-editor .view-line').count(), 0);
	await capture('changes-vps');
	await drawer.getByRole('button', { name: 'Open in Editor', exact: true }).click(); await drawer.waitFor({ state: 'detached' });
	await win.locator('.monaco-editor .view-line').filter({ hasText: '# Remote workspace' }).waitFor();
	await capture('12-vps-code');
	await command('workbench.action.splitEditor');
	assert.equal(await win.locator('.part.editor .editor-group-container').count(), 2, 'Code retains native editor splitting');
	await win.locator('.outscaled-title-controls').getByRole('button', { name: 'Agents', exact: true }).click();
	await until(async () => (await proof())[0]?.text?.includes('PRIVATE_REMOTE_INPUT'), 'VPS return');
	const ssh = readFileSync(sshLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
	// A lost fixture daemon retains workspace rows and terminal membership, labelled offline.
	assert.ok(ssh.some(entry => entry.kind === 'extension-tunnel'));
	daemon.kill('SIGTERM');
	await until(async () => await remoteRow.evaluate(element => element.classList.contains('offline')) && (await remoteRow.locator('.outscaled-workspace-detail').innerText()).includes(' · Offline · '), 'offline VPS row');
	assert.equal(await remoteRow.locator('.outscaled-workspace-dot').count(), 2);
	await capture('13-offline');
	assert.equal(ssh.filter(entry => entry.kind === 'attach').length, 2);
	writeFileSync(join(evidence, 'proof.json'), JSON.stringify({ initial, working, needsInput, before, after, terminals, secondTerminals, geometries, remote, ssh, errors }, null, 2));
	assert.deepEqual(errors, []);
	assert.equal(rendererErrors.some(message => message.includes('Element already has context attribute')), false, 'embedded editors have distinct context scopes');
	console.log('PASS: Changes attribution/count/drawer/native diffs/Git API commit, Code switcher/rail/live dots/grid restoration, core sidebar, live badges, dot/row focus, keyboard navigation, Agents/Code shortcuts, native commands, identity, tmux history, workspace/reload persistence, needs-you focus, six split geometries, New agents modal and keyboard focus, typed commands, fresh launches, non-destructive replacement/reload, right/add insertion, literal prompts, run modes, private presets, pane actions and scoped shortcuts, cross-workspace waiting order and Cmd+J cycling inside terminals, permission answers with exact fake key reports and no-key 409 fallback, waiting background cards without grid changes, persistent background membership and empty grids, nested sash resizing/reload/reset and old layout migration, background chips and cards, live latest lines, horizontal overflow, scheduled creation/run/edit/pause/resume/delete and read-only workspace schedules');
} finally {
	writeFileSync(join(evidence, 'page-errors.json'), JSON.stringify(errors, null, 2));
	writeFileSync(join(evidence, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2));
	if (app) {
		if (win) { try { await capture('last-state'); writeFileSync(join(evidence, 'last-dom.txt'), await win.locator('body').innerText()); writeFileSync(join(evidence, 'last-html.txt'), await win.locator('.outscaled-agents-host').evaluateAll((elements: Element[]) => elements.map(element => element.outerHTML).join('\n'))); writeFileSync(join(evidence, 'last-proof.json'), JSON.stringify(await proof(), null, 2)); writeFileSync(join(evidence, 'last-bridge.json'), JSON.stringify(await win.evaluate(() => ({ mode: (window as ProbedWindow).__agentsProbe.agents.mode, active: [...(window as ProbedWindow).__agentsProbe.agents.owners].map(([id, owner]) => [id, owner.active]), snapshot: (window as ProbedWindow).__agentsProbe.agents.snapshot, receipt: (window as ProbedWindow).__agentsProbe.agents.receipt(), instances: (window as ProbedWindow).__agentsProbe.terminals.instances.map(instance => ({id:instance.instanceId, disposed:instance.isDisposed, launch:instance.shellLaunchConfig})) })), null, 2)); } catch {} }
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
