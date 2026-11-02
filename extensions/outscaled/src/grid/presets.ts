/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { AgentsLaunch, AgentsPreset, defaultLaunch, isAgentsLaunch } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLaunch.js';
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

export function builtInPresets(): AgentsPreset[] {
	return presets.map(preset => ({ name: preset.label, choices: { ...defaultLaunch(), layout: preset.layout, agents: [...preset.commands] } }));
}
interface SavedPreset extends AgentsPreset { workspace: string }
/** Personal launch choices live outside workspace folders and never enter source control. */
export class PresetStore {
	constructor(private readonly directory = process.env.OUTSCALED_CONFIG_DIR ?? join(homedir(), '.config/outscaled')) {}
	private async read(): Promise<SavedPreset[]> {
		let source: string;
		try { source = await readFile(join(this.directory, 'presets.toml'), 'utf8'); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
		const entries = parse(source).preset ?? [];
		if (!Array.isArray(entries) || entries.length > 1000) { throw new Error(l10n.t('Invalid presets.toml')); }
		return entries.map(entry => {
			const candidate = entry as Partial<SavedPreset>;
			if (!candidate || typeof candidate !== 'object' || typeof candidate.workspace !== 'string' || !candidate.workspace || candidate.workspace.length > 32768 ||
				typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 128 ||
				!isAgentsLaunch(candidate.choices)) { throw new Error(l10n.t('Invalid preset')); }
			return { workspace: candidate.workspace, name: candidate.name, choices: { ...candidate.choices } };
		});
	}
	async load(workspace: string): Promise<AgentsPreset[]> { return (await this.read()).filter(entry => entry.workspace === workspace).map(({ name, choices }) => ({ name, choices })); }
	async save(workspace: string, name: string, choices: AgentsLaunch): Promise<void> {
		if (!workspace || !name.trim() || name.length > 128 || !isAgentsLaunch(choices)) { throw new Error(l10n.t('Invalid preset')); }
		const entries = (await this.read()).filter(entry => entry.workspace !== workspace || entry.name !== name.trim());
		if (entries.length >= 1000) { throw new Error(l10n.t('Too many saved presets')); }
		entries.push({ workspace, name: name.trim(), choices });
		await mkdir(this.directory, { recursive: true });
		const file = join(this.directory, 'presets.toml');
		const temporary = `${file}.${process.pid}.tmp`;
		await writeFile(temporary, stringify({ preset: entries }), { mode: 0o600 });
		await rename(temporary, file);
	}
}
