/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AgentsLayout = { type: 'pane'; terminal: string | null } | {
	type: 'split'; direction: 'right' | 'down'; children: AgentsLayout[];
};
export const layoutIds = ['single', 'side-by-side', 'stacked', '2x2', 'four-across', '2+1'] as const;
export type LayoutId = typeof layoutIds[number];

/** Presets are split trees. Depth-first traversal is the specified reading order. */
export function presetLayout(id: LayoutId, terminals: readonly string[]): AgentsLayout {
	let index = 0;
	const pane = (): AgentsLayout => ({ type: 'pane', terminal: terminals[index++] ?? null });
	const split = (direction: 'right' | 'down', children: AgentsLayout[]): AgentsLayout => ({ type: 'split', direction, children });
	switch (id) {
		case 'single': return pane();
		case 'side-by-side': return split('right', [pane(), pane()]);
		case 'stacked': return split('down', [pane(), pane()]);
		case '2x2': return split('down', [split('right', [pane(), pane()]), split('right', [pane(), pane()])]);
		case 'four-across': return split('right', [pane(), pane(), pane(), pane()]);
		case '2+1': return split('right', [split('down', [pane(), pane()]), pane()]);
	}
}

export function layoutTerminals(tree: AgentsLayout): string[] {
	return tree.type === 'pane' ? tree.terminal === null ? [] : [tree.terminal] : tree.children.flatMap(layoutTerminals);
}

/** Inserts beside a leaf without changing any existing pane's identity or order. */
export function splitPane(tree: AgentsLayout, terminal: string, added: string, direction: 'right' | 'down'): AgentsLayout {
	if (tree.type === 'pane') {
		return tree.terminal === terminal ? { type: 'split', direction, children: [tree, { type: 'pane', terminal: added }] } : tree;
	}
	return { ...tree, children: tree.children.map(child => splitPane(child, terminal, added, direction)) };
}

/** Leave empty slots when a daemon identity disappears; never bind a reused name. */
export function reconcileLayout(tree: AgentsLayout, terminals: ReadonlySet<string>): AgentsLayout {
	return tree.type === 'pane' ? { ...tree, terminal: tree.terminal !== null && terminals.has(tree.terminal) ? tree.terminal : null }
		: { ...tree, children: tree.children.map(child => reconcileLayout(child, terminals)) };
}

export function isAgentsLayout(value: unknown, depth = 0, seen = new Set<string>()): value is AgentsLayout {
	if (!value || typeof value !== 'object' || depth > 16) { return false; }
	const tree = value as Partial<AgentsLayout>;
	if (tree.type === 'pane') {
		if (tree.terminal === null) { return true; }
		if (typeof tree.terminal !== 'string' || !tree.terminal || seen.has(tree.terminal)) { return false; }
		seen.add(tree.terminal);
		return true;
	}
	return tree.type === 'split' && (tree.direction === 'right' || tree.direction === 'down') &&
		Array.isArray(tree.children) && tree.children.length >= 2 && tree.children.length <= 64 &&
		tree.children.every(child => isAgentsLayout(child, depth + 1, seen));
}
