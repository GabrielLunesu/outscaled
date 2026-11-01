/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse } from 'smol-toml';

export function validateSshTarget(target: string): void {
	// Match the CLI: one destination argv, never an option, URI or command.
	if (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_\[:][a-zA-Z0-9_.:\[\]-]*$/.test(target)) {
		throw new Error('host must be an SSH host alias or a [user@]host target');
	}
}

export function parseServers(source: string): { hosts: string[]; errors: string[] } {
	const file = parse(source);
	const hosts = ['local'];
	const errors: string[] = [];
	if (Object.keys(file).some(key => key !== 'server')) errors.push('expected only [[server]] entries');
	if (file.server !== undefined && !Array.isArray(file.server)) {
		errors.push('expected [[server]] entries with a host');
		return { hosts, errors };
	}
	for (const [index, entry] of ((file.server ?? []) as unknown[]).entries()) {
		try {
			if (typeof entry !== 'object' || entry === null || !('host' in entry) || typeof entry.host !== 'string'
				|| Object.keys(entry).some(key => key !== 'host')) throw new Error('expected a host string');
			validateSshTarget(entry.host);
			if (entry.host === 'local') throw new Error('local is always included; remove it from the file');
			if (hosts.includes(entry.host)) throw new Error(`duplicate host: ${entry.host}`);
			hosts.push(entry.host);
		} catch (error) {
			errors.push(`server ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { hosts, errors };
}

export function localPort(value: string | undefined): number {
	if (value === undefined) return 7770;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
		throw new Error('WSD_PORT must be an integer between 1 and 65535');
	}
	return Number(value);
}

/** Independent retry sequences for each tunnel and stream. Reset only on recovery. */
export class Backoff {
	private attempt = 0;
	next(): number { return [1000, 5000, 30000, 300000][Math.min(this.attempt++, 3)]; }
	reset(): void { this.attempt = 0; }
}
