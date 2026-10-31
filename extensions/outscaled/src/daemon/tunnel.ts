/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Backoff, validateSshTarget } from './servers';

export function sshArgs(host: string, port: number): string[] {
	validateSshTarget(host);
	return ['-N', '-T',
		'-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
		'-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
		'-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
		'-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no',
		'-o', 'ControlPath=none', '-o', 'PermitLocalCommand=no',
		'-L', `127.0.0.1:${port}:127.0.0.1:7770`, host];
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(error => error ? reject(error) : resolve(port));
		});
	});
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try { process.kill(-child.pid, signal); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPERM') child.kill(signal);
		else if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
	}
}

export class Tunnel {
	private child?: ChildProcess;
	private timer?: NodeJS.Timeout;
	private stopped = false;
	private readonly backoff = new Backoff();
	private readonly onExit = () => { if (this.child) killGroup(this.child, 'SIGKILL'); };

	constructor(private readonly host: string, private readonly env: NodeJS.ProcessEnv,
		private readonly changed: (url: string | undefined, error?: string) => void) {
		process.on('exit', this.onExit);
	}

	start(): void { void this.open(); }
	connected(): void { this.backoff.reset(); }

	private async open(): Promise<void> {
		try {
			const port = await freePort();
			if (this.stopped) return;
			const child = spawn('ssh', sshArgs(this.host, port), { env: this.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
			this.child = child;
			let stderr = '';
			let failure: Error | undefined;
			child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
			child.once('error', error => { failure = error; });
			// Observe the leader rather than 'close': a proxy can inherit stderr.
			let finished = false;
			const finish = (code: number | null) => {
				if (finished) return;
				finished = true;
				killGroup(child, 'SIGKILL');
				if (this.child === child) this.child = undefined;
				if (this.stopped) process.removeListener('exit', this.onExit);
				if (!this.stopped) {
					const detail = (failure?.message ?? stderr).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
					this.retry(`SSH tunnel failed (exit ${code})${detail ? `: ${detail}` : ''}`);
				}
			};
			child.once('exit', finish);
			child.once('error', () => finish(null));
			this.changed(`http://127.0.0.1:${port}`);
		} catch (error) {
			if (!this.stopped) this.retry(String(error));
		}
	}

	private retry(error: string): void {
		this.changed(undefined, error);
		this.timer = setTimeout(() => { void this.open(); }, this.backoff.next());
	}

	dispose(): void {
		if (this.stopped) return;
		this.stopped = true;
		clearTimeout(this.timer);
		const child = this.child;
		if (child) {
			killGroup(child, 'SIGTERM');
			// Keep the escalation even if the leader exits: a proxy may ignore TERM.
			const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 500);
			timer.unref();
		}
		if (!child) process.removeListener('exit', this.onExit);
	}
}
