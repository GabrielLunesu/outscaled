/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface Disposable { dispose(): void; }
interface Tabs<T> {
	readonly all: readonly { readonly tabs: readonly T[] }[];
	onDidChangeTabs(listener: () => void): Disposable;
	onDidChangeTabGroups(listener: () => void): Disposable;
}

/** API disposal bypasses confirmOnKill, unlike closing a terminal's editor tab.
 * Wait for tab/group removal before applying the next layout, but never hold
 * the workspace switch queue indefinitely if VS Code fails to remove a tab.
 */
export function detachPanes<T>(panes: readonly { terminal: Disposable; tab?: T }[], groups: Tabs<T>,
	log: (message: string) => void, timeoutMs = 3000): Promise<void> {
	const tabs = new Set<T>(panes.flatMap(pane => pane.tab === undefined ? [] : [pane.tab]));
	return new Promise(resolve => {
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			for (const subscription of subscriptions) subscription.dispose();
			resolve();
		};
		const remaining = () => groups.all.flatMap(group => group.tabs).filter(tab => tabs.has(tab)).length;
		const check = () => { if (!remaining()) finish(); };
		const subscriptions = [groups.onDidChangeTabs(check), groups.onDidChangeTabGroups(check)];
		const timer = setTimeout(() => {
			log(`Error: Terminal grid detach timed out after ${timeoutMs} ms (${remaining()} tabs remain); continuing workspace switch.`);
			finish();
		}, timeoutMs);
		for (const pane of panes) {
			try { pane.terminal.dispose(); }
			catch (error) { log(`Error: Could not dispose terminal client: ${String(error)}`); }
		}
		check();
	});
}
