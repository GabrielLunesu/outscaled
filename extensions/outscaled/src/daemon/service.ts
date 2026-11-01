/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Connection } from './connection';
import { hostAuthority, localPort, parseServers } from './servers';
import { ServerState } from './state';
import { Tunnel } from './tunnel';

/** Shared extension-owned connections. Consumers never open their own streams/tunnels. */
export class DaemonService {
	private readonly events = new EventEmitter();
	private readonly connections = new Map<string, { connection: Connection; tunnel?: Tunnel }>();
	private readonly diagnostics = new Map<string, string>();
	private readonly timer: NodeJS.Timeout;
	private readonly initialized: Promise<void>;
	private lastSource?: string;
	private reading = false;
	private stopped = false;

	constructor(private readonly log: (message: string) => void, private readonly env: NodeJS.ProcessEnv = process.env) {
		this.add('local');
		this.initialized = this.readServers();
		// Reading the small file also handles absent directories, atomic saves and replacement.
		this.timer = setInterval(() => { void this.readServers(); }, 2000);
	}

	get servers(): readonly ServerState[] { return [...this.connections.values()].map(value => value.connection.state); }

	async request(host: string, path: string, init?: RequestInit): Promise<Response> {
		await this.initialized;
		const entry = this.connections.get(host) ?? [...this.connections.entries()].find(([target]) => hostAuthority(target) === hostAuthority(host))?.[1];
		if (!entry) throw new Error('Server is not configured');
		return entry.connection.request(path, init);
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.events.on('change', listener);
		return { dispose: () => { this.events.off('change', listener); } };
	}

	private report(host: string, error: string): void {
		if (this.diagnostics.get(host) !== error) this.log(`${host}: ${error}`);
		this.diagnostics.set(host, error);
	}

	private add(host: string): void {
		const connection = new Connection(host, () => {
			if (connection.state.online) this.diagnostics.delete(host);
			this.events.emit('change');
		}, error => this.report(host, error), () => this.connections.get(host)?.tunnel?.connected());
		const entry: { connection: Connection; tunnel?: Tunnel } = { connection };
		this.connections.set(host, entry);
		if (host === 'local') {
			try { connection.setEndpoint(`http://127.0.0.1:${localPort(this.env.WSD_PORT)}`); }
			catch (error) { connection.setEndpoint(undefined, String(error)); }
		} else {
			entry.tunnel = new Tunnel(host, this.env, (url, error) => connection.setEndpoint(url, error));
			entry.tunnel.start();
		}
	}

	private async readServers(): Promise<void> {
		if (this.reading || this.stopped) return;
		this.reading = true;
		try {
			const path = join(this.env.OUTSCALED_CONFIG_DIR ?? join(homedir(), '.config/outscaled'), 'servers.toml');
			const source = await readFile(path, 'utf8').catch(error => {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
				throw error;
			});
			if (this.stopped || source === this.lastSource) return;
			const { hosts, errors } = parseServers(source);
			this.lastSource = source;
			if (errors.length) this.report('servers.toml', errors.join('; '));
			else this.diagnostics.delete('servers.toml');
			for (const [host, entry] of this.connections) {
				if (!hosts.includes(host)) {
					entry.connection.dispose(); entry.tunnel?.dispose();
					this.connections.delete(host); this.diagnostics.delete(host);
				}
			}
			for (const host of hosts) if (!this.connections.has(host)) this.add(host);
			// Preserve file order after reordering existing hosts.
			const ordered = hosts.map(host => [host, this.connections.get(host)!] as const);
			this.connections.clear();
			for (const [host, entry] of ordered) this.connections.set(host, entry);
			this.events.emit('change');
		} catch (error) {
			// A broken save/read retains existing connections until corrected.
			if (!this.stopped) this.report('servers.toml', String(error));
		} finally { this.reading = false; }
	}

	async refresh(): Promise<void> {
		await this.readServers();
		for (const { connection } of this.connections.values()) connection.refresh();
	}

	dispose(): void {
		this.stopped = true;
		clearInterval(this.timer);
		for (const { connection, tunnel } of this.connections.values()) { connection.dispose(); tunnel?.dispose(); }
		this.connections.clear();
		this.events.removeAllListeners();
	}
}
