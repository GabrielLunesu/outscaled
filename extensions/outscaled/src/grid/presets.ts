/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutId, layoutIds } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLayout.js';

export const layouts = layoutIds.map(id => ({ id, label: ({ single: 'Single', 'side-by-side': 'Side by side', stacked: 'Stacked', '2x2': '2×2', 'four-across': 'Four across', '2+1': 'Two stacked + right' })[id],
	count: ({ single: 1, 'side-by-side': 2, stacked: 2, '2x2': 4, 'four-across': 4, '2+1': 3 })[id] }));
export type PaneCommand = 'claude' | 'codex' | 'shell';
export interface GridPreset { id: string; label: string; layout: LayoutId; commands: readonly PaneCommand[] }
export interface GridPane { name: string; command?: string  }
export const presets: readonly GridPreset[] = [
	{ id: '2-claude-2-codex', label: '2 Claude + 2 Codex', layout: '2x2', commands: ['claude', 'claude', 'codex', 'codex'] },
	{ id: 'claude-shell', label: '1 Claude + shell', layout: 'side-by-side', commands: ['claude', 'shell'] },
	...layouts.map(layout => ({ id: `shells-${layout.id}`, label: `${layout.label} · shells`, layout: layout.id,
		commands: Array.from({ length: layout.count }, () => 'shell' as const) }))
];
export function expandPreset(preset: GridPreset): { layout: typeof layouts[number]; panes: GridPane[] } {
	const layout = layouts.find(layout => layout.id === preset.layout);
	if (!layout || preset.commands.length !== layout.count) {throw new Error('Preset does not fill its layout');}
	const counts = new Map<PaneCommand, number>();
	return { layout, panes: preset.commands.map(command => {
		const count = (counts.get(command) ?? 0) + 1;
		counts.set(command, count);
		return { name: `${command}-${count}`, ...(command === 'shell' ? {} : { command }) };
	}) };
}
