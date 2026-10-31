/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Health, StreamMessage, Terminal, Workspace } from '@outscaled/protocol';
import WebSocket from 'ws';
import { Backoff } from './servers';
import { applyMessage, ServerState } from './state';

/** One stream per server. A generation prevents obsolete requests from publishing. */
export class Connection {
	readonly state: ServerState;
	private url?: string;
	private socket?: WebSocket;
	private controller?: AbortController;
	private timer?: NodeJS.Timeout;
	private generation = 0;
	private stopped = false;
	private fetching = false;
	private dirty = false;
	private pending: StreamMessage[] = [];
	private readonly backoff = new Backoff();

	constructor(host: string, private readonly changed: () => void, private readonly report: (error: string) => void,
		private readonly recovered: () => void = () => {}) {
		this.state = { host, online: false, error: 'Connecting…', workspaces: [], terminals: [] };
	}

	setEndpoint(url: string | undefined, error?: string): void {
		if (this.stopped) return;
		this.cancel();
		this.url = url;
		this.state.online = false;
		this.state.error = error ?? 'Connecting…';
		this.changed();
		if (url) this.connect();
		else if (error) this.report(error);
	}

	private cancel(): void {
		this.generation++;
		clearTimeout(this.timer);
		this.controller?.abort();
		this.socket?.terminate();
		this.socket = undefined;
		this.fetching = false;
		this.pending = [];
		this.dirty = false;
	}

	private connect(): void {
		if (this.stopped || !this.url) return;
		const generation = this.generation;
		this.controller = new AbortController();
		const socket = new WebSocket(`${this.url.replace(/^http/, 'ws')}/v1/stream`, { handshakeTimeout: 10000 });
		this.socket = socket;
		let failed = false;
		const fail = (error: string) => {
			if (failed || generation !== this.generation || this.stopped) return;
			failed = true;
			this.cancel();
			this.state.online = false;
			this.state.error = error;
			this.report(error);
			this.changed();
			this.timer = setTimeout(() => this.connect(), this.backoff.next());
		};
		socket.on('error', error => fail(error.message));
		socket.on('close', (code, reason) => fail(`Stream closed (${code})${reason.length ? `: ${reason}` : ''}`));
		socket.on('open', () => { void this.snapshot(generation, fail); });
		socket.on('message', data => {
			if (generation !== this.generation) return;
			try {
				const message = StreamMessage.parse(JSON.parse(data.toString()));
				if (this.fetching) {
					if (this.pending.length >= 10000) throw new Error('Stream snapshot buffer exceeded');
					this.pending.push(message);
				} else {
					if (applyMessage(this.state, message)) void this.snapshot(generation, fail);
					this.changed();
				}
			} catch (error) { fail(`Invalid stream message: ${error instanceof Error ? error.message : String(error)}`); }
		});
		// Refresh shares the snapshot queue and this socket's failure handler.
		this.refreshSnapshot = () => { void this.snapshot(generation, fail); };
	}

	private refreshSnapshot = () => {};

	private async snapshot(generation: number, fail: (error: string) => void): Promise<void> {
		if (this.stopped || generation !== this.generation) return;
		if (this.fetching) { this.dirty = true; return; }
		this.fetching = true;
		try {
			do {
				this.dirty = false;
				const signal = AbortSignal.any([this.controller!.signal, AbortSignal.timeout(3000)]);
				const request = async (path: string): Promise<unknown> => {
					const response = await fetch(`${this.url}/v1/${path}`, { signal });
					if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
					return response.json();
				};
				const [health, workspaces, terminals] = await Promise.all([
					request('health').then(value => Health.parse(value)),
					request('workspaces').then(value => Workspace.array().parse(value)),
					request('terminals').then(value => Terminal.array().parse(value))
				]);
				if (generation !== this.generation) return;
				Object.assign(this.state, { health, workspaces, terminals, online: true, error: undefined });
				// Replay live changes over the HTTP snapshot, then refetch membership if needed.
				for (const message of this.pending.splice(0)) this.dirty = applyMessage(this.state, message) || this.dirty;
				this.backoff.reset();
				this.recovered();
				this.changed();
			} while (this.dirty);
		} catch (error) {
			if (generation === this.generation) fail(`Daemon request failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (generation === this.generation) this.fetching = false;
		}
	}

	refresh(): void {
		if (this.stopped || !this.url) return;
		if (this.socket?.readyState === WebSocket.OPEN) this.refreshSnapshot();
		else { this.cancel(); this.connect(); }
	}

	dispose(): void { this.stopped = true; this.cancel(); }
}
