/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Private harness agent. Control files redraw the screen without submitting terminal input.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export function runFakeAgent(agent: string): void {
	const report = (value: Record<string, string | number>) => appendFileSync(process.env.TEST_PERMISSION_REPORT!, JSON.stringify({ terminal: process.env.WSD_TERMINAL, ...value }) + '\n');
	appendFileSync(process.env.TEST_AGENT_LOG!, JSON.stringify({ agent, args: process.argv.slice(2) }) + '\n');
	const ready = () => console.log(process.argv.includes('SCHEDULE_FIXTURE') ? 'SCHEDULE_RESULT' : `fake ${agent} ready — AGENTS_VIEW`);
	let reader: ReturnType<typeof createInterface>;
	const readLines = () => {
		reader = createInterface({ input: process.stdin });
		reader.on('line', async line => {
			if (line === 'HISTORY') { for (let i = 1; i <= 80; i++) { console.log('AGENTS_HISTORY_' + i); } ready(); }
			console.log('received:' + line);
			if (line === 'EDIT_CHANGES') {
				const hook = async (runtime: string, payload: object) => {
					const response = await fetch(`http://127.0.0.1:${process.env.WSD_PORT}/v1/hooks/${runtime}`, {
						method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ terminal: process.env.WSD_TERMINAL, payload }) });
					if (!response.ok) { report({ hookError: response.status }); }
				};
				if (agent === 'claude') {
					writeFileSync('README.md', '# Agents view\n\nClaude edit from fake tool.\n');
					await hook('claude-code', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(process.cwd(), 'README.md') } });
					await hook('claude-code', { hook_event_name: 'Stop' });
				} else {
					writeFileSync('codex-change.ts', 'export const codexChange = true;\n');
					await hook('codex', { type: 'agent-turn-complete' });
				}
			}

		});
	};
	ready(); readLines();
	if (agent !== 'claude') { return; }
	let lastControl = '';
	let permission = false;
	const receiveKey = (chunk: Buffer) => {
		for (const key of chunk.toString()) {
			report({ key });
			if (/^[1-9]$/.test(key)) {
				permission = false;
				process.stdin.removeListener('data', receiveKey); process.stdin.setRawMode(false);
				process.stdout.write('\x1b[2J\x1b[H'); console.log('Permission answered: ' + key); ready(); readLines();
			}
		}
	};
	setInterval(() => {
		let source;
		try { source = readFileSync(join(process.env.TEST_PERMISSION_CONTROL!, process.env.WSD_TERMINAL + '.json'), 'utf8'); } catch { return; }
		if (source === lastControl) { return; } lastControl = source;
		const { screen } = JSON.parse(source);
		if (screen === 'clear') {
			process.stdout.write('\x1b[2J\x1b[HScreen changed; permission is no longer visible.\r\n'); report({ screen }); return;
		}
		if (!permission) {
			reader.close(); process.stdin.setRawMode(true); process.stdin.on('data', receiveKey); process.stdin.resume(); permission = true;
		}
		const fixture = readFileSync(join(process.env.TEST_PERMISSION_FIXTURES!, screen === 'edit' ? '1-edit.txt' : '3-bash.txt'), 'utf8').trimEnd();
		process.stdout.write('\x1b[2J\x1b[H' + fixture.replaceAll('\n', '\r\n') + '\r\n');
		report({ screen });
		// Send the same Notification hook as Claude after the screen has reached tmux.
		setTimeout(() => fetch(`http://127.0.0.1:${process.env.WSD_PORT}/v1/hooks/claude-code`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ terminal: process.env.WSD_TERMINAL, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs permission.' } })
		}).then(response => { if (!response.ok) { report({ hookError: response.status }); } }).catch(error => report({ hookError: String(error) })), 100);
	}, 50);
}
