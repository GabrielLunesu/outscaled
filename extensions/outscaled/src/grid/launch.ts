/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';
import { AgentsLaunch, insertLaunch, launchLayout, launchNames } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLaunch.js';
import { AgentsLayout, isAgentsLayout, layoutTerminals } from '../../../../src/vs/workbench/contrib/outscaled/common/agentsLayout.js';

/** POSIX single quotes preserve every prompt character through the daemon's login shell. */
// eslint-disable-next-line local/code-no-unexternalized-strings -- POSIX shell quoting syntax, not UI text.
export function quotePrompt(prompt: string): string { return "'" + prompt.replaceAll("'", "'\\''") + "'"; }
export function agentCommand(agent: AgentsLaunch['agents'][number], prompt: string): string | undefined {
	return agent === 'shell' ? undefined : agent + (prompt ? ` -- ${quotePrompt(prompt)}` : '');
}
export function planLaunch(choices: AgentsLaunch, existing: readonly string[], tree: AgentsLayout, focused?: string) {
	if (choices.run === 'scheduled') { throw new Error(l10n.t('Scheduled agents in terminals are not available yet')); }
	const names = launchNames(choices.agents, existing);
	// Validate topology before creating anything; final daemon ids replace these unique placeholders.
	const layout = insertLaunch(tree, launchLayout(choices, names.map(name => `new:${name}`)), choices.where, focused);
	if (!isAgentsLayout(layout)) { throw new Error(l10n.t('The resulting grid is too deeply nested')); }
	return { panes: names.map((name, index) => ({ name, command: agentCommand(choices.agents[index], choices.prompt), alwaysOn: choices.run === 'always' })),
		leaving: choices.where === 'replace' ? layoutTerminals(tree) : [] };
}
