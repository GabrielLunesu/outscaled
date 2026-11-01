/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export * from './vscode';
import { Disposable, EventEmitter } from './vscode';
export class TabInputTerminal {}
export const l10n = { t: (text: string) => text };
export const calls: unknown[][] = [];
export const handlers = new Map<string, (...args: any[]) => any>();
export const commands = {
	registerCommand(name: string, handler: (...args: any[]) => any) {
		handlers.set(name, handler); return new Disposable(() => handlers.delete(name));
	},
	async executeCommand(name: string, ...args: any[]) {
		calls.push([name, ...args]);
		return handlers.get(name)?.(...args);
	}
};
export const settings = new Map<string, unknown>();
export const workspace = { getConfiguration: () => ({ get: (key: string, fallback?: unknown) => settings.get(key) ?? fallback }) };
const tabChanges = new EventEmitter<void>();
const closedTerminals = new EventEmitter<any>();
export const window = {
	state: { focused: true },
	tabGroups: { all: [] as any[], activeTabGroup: { viewColumn: 1 },
		onDidChangeTabs: tabChanges.event, onDidChangeTabGroups: tabChanges.event },
	onDidCloseTerminal: closedTerminals.event,
	showWarningMessage: async (message: string, ...items: string[]) => {
		calls.push(['warning', message, ...items]); return handlers.get('message')?.();
	},
	showErrorMessage: async (message: string, ...items: string[]) => {
		calls.push(['error', message, ...items]); return handlers.get('message')?.();
	},
	createTerminal: (options: any) => {
		calls.push(['createTerminal', options.name]);
		let group = window.tabGroups.all.find(group => group.viewColumn === options.location.viewColumn);
		if (!group) { group = { viewColumn: options.location.viewColumn, tabs: [] }; window.tabGroups.all.push(group); }
		const tab = { label: options.name, input: new TabInputTerminal(), group };
		group.tabs.push(tab);
		const terminal = { name: options.name, processId: Promise.resolve(1234),
			show: () => { calls.push(['show', options.name]); group.activeTab = tab; tabChanges.fire(); },
			dispose: () => {
				group.tabs = group.tabs.filter((candidate: any) => candidate !== tab);
				if (group.activeTab === tab) group.activeTab = group.tabs.at(-1);
				closedTerminals.fire(terminal); tabChanges.fire();
			}
		};
		return terminal;
	}
};
