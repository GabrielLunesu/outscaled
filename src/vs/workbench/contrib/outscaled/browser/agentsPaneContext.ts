/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
// eslint-disable-next-line local/code-translation-remind
import { localize } from '../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';

export const agentsPaneMenu = new MenuId('OutscaledAgentsPane');
export const agentsPaneFocus = new RawContextKey<boolean>('outscaledAgentsPaneFocus', false);
export const agentsModeActive = new RawContextKey<boolean>('outscaledAgentsMode', false);
export const agentsPaneCommandIds = ['addClaudeRight', 'addCodexRight', 'addShellRight', 'addClaudeBelow', 'addCodexBelow', 'addShellBelow', 'background'].map(name => `outscaled.agents.${name}`);

/** Pane-scoped context follows focus, including the terminal's own child context. */
export function createPaneContext(element: HTMLElement, header: HTMLElement, terminal: string, context: IContextKeyService,
	menus: IMenuService, contextMenus: IContextMenuService, store: DisposableStore): IContextKeyService {
	const scoped = store.add(context.createScoped(element));
	agentsPaneFocus.bindTo(scoped).set(true);
	const menu = store.add(menus.createMenu(agentsPaneMenu, scoped));
	const button = dom.append(header, dom.$<HTMLButtonElement>('button.outscaled-pane-menu.codicon.codicon-ellipsis', {
		type: 'button', 'aria-label': localize('agents.paneActions', "Pane Actions"), 'aria-haspopup': 'menu'
	}));
	store.add(dom.addDisposableListener(button, 'click', () => contextMenus.showContextMenu({
		getAnchor: () => button,
		getActions: () => getFlatContextMenuActions(menu.getActions({ shouldForwardArgs: true })),
		getActionsContext: () => ({ terminal }),
		contextKeyService: scoped,
		onHide: () => { if (button.isConnected) { button.focus(); } }
	})));
	return scoped;
}
