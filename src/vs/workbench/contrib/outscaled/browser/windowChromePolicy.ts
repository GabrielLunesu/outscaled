/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMenuItem, ISubmenuItem, isIMenuItem } from '../../../../platform/actions/common/actions.js';

// Only these commands are overridden. Other removed features remain callable internally.
export const hiddenBarCommandIds = [
	'workbench.action.toggleActivityBarVisibility',
	'workbench.action.activityBarLocation.default',
	'workbench.action.activityBarLocation.top',
	'workbench.action.activityBarLocation.bottom',
	'workbench.action.activityBarLocation.hide',
	'workbench.action.focusActivityBar',
	'workbench.action.toggleStatusbarVisibility',
	'workbench.action.focusStatusBar'
] as const;

// Match complete namespaces, never words embedded in unrelated command IDs.
const hiddenCommandPrefixes = [
	'chat.', 'chatEditing.', 'chatEditor.', '_chat.',
	'inlineChat.', 'inlineChat2.', 'inlineChatWidget.',
	'github.copilot.', 'github.copilot-chat.', 'GitHub.copilot-chat.',
	'editor.action.inlineSuggest.', 'editor.action.inlineEdit.',
	'workbench.action.chat.', 'workbench.action.chatEditor.', 'workbench.chat.',
	'workbench.edit.chat.', 'workbench.panel.chat.',
	'_workbench.action.chat.', 'workbench.action.quickchat.',
	'workbench.action.openChat.', 'workbench.action.terminal.chat.',
	'notebook.cell.chat.', 'notebook.inlineChat.', 'notebook.chat.',
	'workbench.action.agentHost.', 'agentHost.', 'agentSession.', 'agentSessions.', 'agentSessionsViewer.', 'agentsVoice.',
	'aiCustomizationManagement.', 'aiCustomization.', 'workbench.action.aiCustomization.',
	'planReviewFeedback.action.', 'workbench.agentPlugins.',
	'workbench.views.agentPlugins.', 'workbench.views.mcp.',
	'workbench.mcp.', 'workbench.action.mcp.', 'mcp.',
	'workbench.userDataSync.actions.', 'workbench.actions.accounts.',
	'walkthroughs.', 'toggle.chat.'
];

const hiddenCommandIds = new Set<string>([
	...hiddenBarCommandIds,
	'workbench.panel.chat',
	'workbench.action.unifiedQuickAccess', 'workbench.action.showAgentSessionsQuickAccess',
	'workbench.action.onboarding.resetShownState', 'workbench.action.browser.clearAgentStorage',
	'workbench.action.output.show.mcpGateway',
	'workbench.action.edits.submit', 'workbench.action.edits.addFilesFromReferences',
	'search.action.searchWithAI', 'scm.editor.triggerSetup', 'settings.action.toggleAiSearch',
	'workbench.command.new.agent', 'workbench.command.new.instructions', 'workbench.command.new.prompt',
	'workbench.command.new.skill', 'workbench.command.new.untitled.prompt',
	'workbench.action.openWorkspaceInAgentsWindow', 'workbench.action.openLanguageModelsJson',
	'workbench.action.speech.stopReadAloud', 'extensions.actions.searchByCategory.AI',
	'workbench.action.openChat', 'workbench.action.openChatToSide',
	'workbench.action.newChatWindow', 'workbench.action.openQuickChat',
	'workbench.action.openAgentsWindow', 'workbench.action.openAgentSessionsWelcome',
	'workbench.action.openWalkthrough', 'workbench.action.welcomeOnboarding2026',
	'welcome.goBack', 'welcome.markStepComplete', 'welcome.markStepIncomplete',
	'welcome.showAllWalkthroughs', 'welcome.newWorkspaceChat', 'resetGettingStartedProgress',
	'workbench.action.manageAccounts', 'workbench.actions.accounts',
	'workbench.action.syncAccountPolicy', 'workbench.extensions.action.manageAccountPreferences',
	'workbench.extensions.actions.gallery.signIn', 'workbench.userData.actions.signin',
	'workbench.userData.actions.turningOn', 'workbench.userData.actions.cancelTurnOn',
	'workbench.actions.syncData.reset',
	'_signOutOfAccount', '_manageTrustedExtensionsForAccount', '_manageAccountPreferencesForExtension',
	'_manageTrustedMCPServersForAccount', '_manageAccountPreferencesForMcpServer',
	'notebook.cellOutput.addToChat',
	'workbench.scm.action.graph.addHistoryItemToChat', 'workbench.scm.action.graph.addHistoryItemChangeToChat',
	'workbench.debug.action.addVariableToChat', 'workbench.debug.action.addWatchExpressionToChat', 'workbench.debug.action.addScopeToChat',
	'workbench.action.browser.addElementToChat', 'workbench.action.browser.addElementCommentToChat',
	'workbench.action.browser.addConsoleLogsToChat', 'workbench.action.browser.addScreenshotToChat',
	'workbench.action.browser.addAreaScreenshotToChat', 'workbench.action.browser.addFullPageScreenshotToChat',
	'_workbench.action.openCopilotSurvey', 'extensions.actions.searchByCategory.Chat'
]);

const hiddenSubmenuIds = new Set([
	'ActivityBarPositionMenu', 'AccountsContext', 'BrowserChatActionsMenu', 'AgentsTitleBarControlMenu',
	'ChatNewMenu', 'ChatTitleBarMenu', 'ChatEditingSessionChangesVersionsSubmenu',
	'AgentSessionsViewerFilterSubMenu', 'AgentSessionsExternalFilterSubMenu', 'AgentSessionsCreateSubMenu'
]);

/** Restrict presentation only; commands remain available to internal callers. */
export function isWindowCommandAllowed(id: string): boolean {
	return !hiddenCommandIds.has(id) && !hiddenCommandPrefixes.some(prefix => id.startsWith(prefix));
}

/** Use extension-provided titles only as a fallback when an extension uses its own namespace. */
export function isWindowMenuItemAllowed(item: IMenuItem | ISubmenuItem): boolean {
	if (!isIMenuItem(item)) {
		return !hiddenSubmenuIds.has(item.submenu.id) && isWindowCommandAllowed(item.submenu.id);
	}
	if (!isWindowCommandAllowed(item.command.id) || (item.alt && !isWindowCommandAllowed(item.alt.id))) {
		return false;
	}
	if (!item.command.source) {
		return true;
	}
	const title = item.command.title;
	const category = item.command.category;
	const original = `${typeof category === 'string' ? category : category?.original ?? ''} ${typeof title === 'string' ? title : title.original}`;
	return !/\b(chat|copilot|AI|accounts?|sign[ -]?in|sign[ -]?out)\b/i.test(original);
}
