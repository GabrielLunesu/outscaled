/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentsLayout, LayoutId, layoutIds, layoutTerminals, presetLayout } from './agentsLayout.js';

export type LaunchAgent = 'claude' | 'codex' | 'shell';
export interface AgentsLaunch {
	layout: LayoutId;
	agents: LaunchAgent[];
	run: 'quick' | 'always' | 'scheduled';
	interval: string;
	where: 'replace' | 'add' | 'right' | 'below';
	prompt: string;
}
export interface AgentsPreset { name: string; choices: AgentsLaunch }
export const layoutCounts: Record<LayoutId, number> = { single: 1, 'side-by-side': 2, stacked: 2, '2x2': 4, 'four-across': 4, '2+1': 3 };
export function defaultLaunch(): AgentsLaunch { return { layout: 'single', agents: ['claude'], run: 'quick', interval: '30m', where: 'replace', prompt: '' }; }
export function isLaunchInterval(value: string): boolean { return /^[1-9]\d{0,5}[mhd]$/.test(value); }
export function isAgentsLaunch(value: unknown): value is AgentsLaunch {
	if (!value || typeof value !== 'object') { return false; }
	const launch = value as AgentsLaunch;
	return layoutIds.includes(launch.layout) && Array.isArray(launch.agents) && launch.agents.length === layoutCounts[launch.layout] &&
		launch.agents.every(agent => ['claude', 'codex', 'shell'].includes(agent)) && ['quick', 'always', 'scheduled'].includes(launch.run) &&
		typeof launch.interval === 'string' && isLaunchInterval(launch.interval) && ['replace', 'add', 'right', 'below'].includes(launch.where) &&
		typeof launch.prompt === 'string' && launch.prompt.length <= 32768 && !launch.prompt.includes('\0');
}

/** Schedules have no shell pane or placement, and always need a prompt. */
export function canLaunchAgents(choices: AgentsLaunch, focused?: string): boolean {
	return isAgentsLaunch(choices) && (choices.run === 'scheduled'
		? !!choices.prompt.trim() && !choices.agents.includes('shell')
		: !['right', 'below'].includes(choices.where) || !!focused);
}

/** Parse only a small explicit vocabulary. Unconsumed input is reported, never executed. */
export function parseAgentsCommand(input: string): { choices: AgentsLaunch; understood: boolean; ignored: string[] } {
	const choices = defaultLaunch();
	let source = input.toLowerCase().trim().replace(/\s+/g, ' ');
	let understood = false;
	const take = (pattern: RegExp, accept: (match: RegExpExecArray) => boolean | void) => {
		for (const match of [...source.matchAll(pattern)]) {
			if (accept(match) !== false) { source = source.replace(match[0], ' '); understood = true; }
		}
	};
	let explicitLayout = false;
	const layoutWords: Record<string, LayoutId> = { '2x2': '2x2', 'four across': 'four-across', 'side by side': 'side-by-side', stacked: 'stacked', single: 'single', 'two stacked plus right': '2+1' };
	take(/\b(2x2|four across|side by side|stacked|single|two stacked plus right)\b/g, match => {
		choices.layout = layoutWords[match[1]];
		explicitLayout = true;
	});
	take(/\bevery ([1-9]\d{0,5}[mhd])\b/g, match => { choices.run = 'scheduled'; choices.interval = match[1]; });
	take(/\balways(?: on)?\b/g, () => { choices.run = 'always'; });
	take(/\b(right|below|add|replace)\b/g, match => { choices.where = match[1] as AgentsLaunch['where']; });
	const agents: LaunchAgent[] = [];
	take(/\b(?:(\d+) )?(claude|codex|shell)\b/g, match => {
		const count = Number(match[1] ?? 1);
		if (count < 1 || count > 4) { return false; }
		agents.push(...Array.from({ length: count }, () => match[2] as LaunchAgent));
		return true;
	});
	const ignored = source.replace(/\+|\band\b/g, ' ').trim().split(/\s+/).filter(Boolean);
	if (agents.length > 4) { return { choices, understood: false, ignored: [input.trim()] }; }
	if (agents.length) {
		if (!explicitLayout) { choices.layout = (['single', 'side-by-side', '2+1', '2x2'] as const)[agents.length - 1]; }
		choices.agents = Array.from({ length: layoutCounts[choices.layout] }, (_, index) => agents[index] ?? agents[0]);
	} else { choices.agents = Array.from({ length: layoutCounts[choices.layout] }, () => 'claude'); }
	return { choices, understood, ignored };
}

/** Replace changes membership only. Add wraps the grid; relative insertion replaces one leaf. */
export function insertLaunch(tree: AgentsLayout, added: AgentsLayout, where: AgentsLaunch['where'], focused?: string): AgentsLayout {
	if (where === 'replace' || !layoutTerminals(tree).length) { return added; }
	if (where === 'add') { return { type: 'split', direction: 'right', children: [tree, added] }; }
	if (!focused || !layoutTerminals(tree).includes(focused)) { throw new Error('A focused pane is required'); }
	const insert = (node: AgentsLayout): AgentsLayout => node.type === 'pane'
		? node.terminal === focused ? { type: 'split', direction: where === 'below' ? 'down' : 'right', children: [node, added] } : node
		: { ...node, children: node.children.map(insert) };
	return insert(tree);
}

/** Allocate new names without reusing even exited identities or mutating existing sessions. */
export function launchNames(agents: readonly LaunchAgent[], existing: readonly string[]): string[] {
	const used = new Set(existing);
	return agents.map(agent => {
		let index = 1;
		while (used.has(`${agent}-${index}`)) { index++; }
		const name = `${agent}-${index}`; used.add(name); return name;
	});
}
export function launchLayout(choices: AgentsLaunch, ids: string[]): AgentsLayout { return presetLayout(choices.layout, ids); }
