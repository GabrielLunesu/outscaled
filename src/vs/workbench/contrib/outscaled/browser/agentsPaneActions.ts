/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
// eslint-disable-next-line local/code-translation-remind
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { defaultLaunch, LaunchAgent } from '../common/agentsLaunch.js';
import { layoutTerminals } from '../common/agentsLayout.js';
import { agentsModeActive, agentsPaneCommandIds, agentsPaneFocus, agentsPaneMenu } from './agentsPaneContext.js';
import { IAgentsService } from './agentsService.js';

const titles = [
	localize2('agents.addClaudeRight', "Add Claude to the Right"),
	localize2('agents.addCodexRight', "Add Codex to the Right"),
	localize2('agents.addShellRight', "Add Shell to the Right"),
	localize2('agents.addClaudeBelow', "Add Claude Below"),
	localize2('agents.addCodexBelow', "Add Codex Below"),
	localize2('agents.addShellBelow', "Add Shell Below"),
	localize2('agents.background', "Move to Background")
];
const bindings = [KeyMod.CtrlCmd | KeyCode.KeyD, KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.KeyD, 0,
	KeyMod.Shift | KeyMod.CtrlCmd | KeyCode.KeyD, KeyMod.Shift | KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.KeyD, 0, KeyMod.CtrlCmd | KeyCode.KeyM];
for (const [index, id] of agentsPaneCommandIds.entries()) {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id, title: titles[index], f1: true, precondition: agentsModeActive,
				menu: { id: agentsPaneMenu, group: index < 3 ? '1_right' : index < 6 ? '2_below' : '3_background', order: index },
				keybinding: bindings[index] ? { primary: bindings[index], when: ContextKeyExpr.and(agentsModeActive, agentsPaneFocus), weight: KeybindingWeight.WorkbenchContrib + 100 } : undefined });
		}
		async run(accessor: ServicesAccessor, target?: { terminal?: string; instanceId?: number }): Promise<void> {
			const agents = accessor.get(IAgentsService);
			if (agents.mode !== 'agents') { return; }
			const workspace = agents.snapshot.workspaces.find(workspace => workspace.selected);
			if (!workspace) { return; }
			const owner = agents.owners.get(workspace.id);
			const terminal = target?.terminal ?? (target?.instanceId === undefined ? owner?.active
				: [...owner?.panes ?? []].find(([, pane]) => pane.instance.instanceId === target.instanceId)?.[0]);
			if (!terminal || !layoutTerminals(workspace.layout).includes(terminal)) { return; }
			if (index === 6) { await agents.request({ version: 1, action: 'background', workspace: workspace.id, terminal, focused: owner?.nearest(terminal) }); }
			else {
				const agent: LaunchAgent = (['claude', 'codex', 'shell'] as const)[index % 3];
				await agents.request({ version: 1, action: 'launch', workspace: workspace.id, focused: terminal,
					choices: { ...defaultLaunch(), agents: [agent], where: index < 3 ? 'right' : 'below' } });
			}
		}
	});
}
MenuRegistry.appendMenuItem(MenuId.TerminalInstanceContext, { submenu: agentsPaneMenu, title: localize2('agents.paneMenu', "Pane Actions").value,
	when: ContextKeyExpr.and(agentsModeActive, agentsPaneFocus), group: '1_create', order: 0 });
