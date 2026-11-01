/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface EditorGroupLayout { orientation?: 0 | 1; groups: { groups?: EditorGroupLayout['groups'] }[]; }
export interface GridLayout { id: string; label: string; editor: EditorGroupLayout; /** ViewColumns in preset fill order. */ columns: readonly number[]; }

// Depth-first editor group order is row-major for this 2×2 definition. In 2+1,
// the two left groups precede the full-height right group.
export const layouts: readonly GridLayout[] = [
	{ id: 'single', label: 'Single', editor: { orientation: 0, groups: [{}] }, columns: [1] },
	{ id: 'side-by-side', label: 'Side by side', editor: { orientation: 0, groups: [{}, {}] }, columns: [1, 2] },
	{ id: 'stacked', label: 'Stacked', editor: { orientation: 1, groups: [{}, {}] }, columns: [1, 2] },
	{ id: '2x2', label: '2×2', editor: { orientation: 1, groups: [{ groups: [{}, {}] }, { groups: [{}, {}] }] }, columns: [1, 2, 3, 4] },
	{ id: 'four-across', label: 'Four across', editor: { orientation: 0, groups: [{}, {}, {}, {}] }, columns: [1, 2, 3, 4] },
	{ id: '2+1', label: 'Two stacked + right', editor: { orientation: 0, groups: [{ groups: [{}, {}] }, {}] }, columns: [1, 2, 3] }
];
export type PaneCommand = 'claude' | 'codex' | 'shell';
export interface GridPreset { id: string; label: string; layout: string; commands: readonly PaneCommand[]; }
export interface GridPane { name: string; command?: string; viewColumn: number; }
export const presets: readonly GridPreset[] = [
	{ id: '2-claude-2-codex', label: '2 Claude + 2 Codex', layout: '2x2', commands: ['claude', 'claude', 'codex', 'codex'] },
	{ id: 'claude-shell', label: '1 Claude + shell', layout: 'side-by-side', commands: ['claude', 'shell'] },
	...layouts.map(layout => ({ id: `shells-${layout.id}`, label: `${layout.label} · shells`, layout: layout.id,
		commands: layout.columns.map(() => 'shell' as const) }))
];
export function expandPreset(preset: GridPreset): { layout: GridLayout; panes: GridPane[] } {
	const layout = layouts.find(layout => layout.id === preset.layout);
	if (!layout || preset.commands.length !== layout.columns.length) throw new Error('Preset does not fill its layout');
	const counts = new Map<PaneCommand, number>();
	return { layout, panes: preset.commands.map((command, index) => {
		const count = (counts.get(command) ?? 0) + 1;
		counts.set(command, count);
		return { name: `${command}-${count}`, ...(command === 'shell' ? {} : { command }), viewColumn: layout.columns[index] };
	}) };
}
