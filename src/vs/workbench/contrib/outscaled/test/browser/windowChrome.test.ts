/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spy } from 'sinon';
import { ResourceMap } from '../../../../../base/common/map.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry, isIMenuItem, registerMenuItemFilter } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { Configuration, ConfigurationModel } from '../../../../../platform/configuration/common/configurationModels.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ChatEditorInputSerializer } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { isWindowCommandAllowed, isWindowMenuItemAllowed } from '../../browser/windowChromePolicy.js';

suite('Outscaled - Window Chrome', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('removes AI, accounts, onboarding and bar commands while preserving native editing', () => {
		const removed = ['workbench.action.chat.open', 'github.copilot.generate', 'inlineChat.start', 'editor.action.inlineSuggest.trigger', 'editor.action.inlineEdit.accept', 'workbench.action.openAgentsWindow', 'workbench.action.openWalkthrough', 'workbench.userDataSync.actions.turnOn', 'workbench.actions.accounts', 'workbench.action.toggleStatusbarVisibility', 'workbench.action.toggleActivityBarVisibility', 'workbench.action.activityBarLocation.top', 'workbench.userData.actions.signin'];
		const retained = ['workbench.view.explorer', 'workbench.action.findInFiles', 'workbench.view.scm', 'workbench.action.showCommands', 'workbench.action.openSettings', 'workbench.action.openGlobalKeybindings', 'workbench.view.extensions', 'editor.action.quickFix', 'editor.action.rename', 'editor.action.triggerSuggest', 'outscaled.testNotification', 'git.stage', 'plain.maintain', 'editor.action.matchAt', 'notebook.cell.statusBar.show', 'example.accounting.open', '_workbench.whenAccountPolicySettled', 'extension.chatty.open', 'welcome.showNewFileEntries', 'git.blame.toggleStatusBarItem', 'editor.emmet.action.nextEditPoint', 'workbench.action.browser.setUserAgent', 'workbench.action.terminal.attachToSession'];
		assert.deepStrictEqual([removed.map(isWindowCommandAllowed), retained.map(isWindowCommandAllowed)], [removed.map(() => false), retained.map(() => true)]);
	});

	test('does not use built-in titles or categories to guess capability ownership', () => {
		assert.deepStrictEqual([
			isWindowMenuItemAllowed({ command: { id: 'example.matchAt', title: 'Chat' } }),
			isWindowMenuItemAllowed({ command: { id: 'example.accounting.open', title: 'Account Statistics' } }),
			isWindowMenuItemAllowed({ command: { id: 'example.extension.open', title: 'Chat', source: { id: 'example.extension', title: 'Example' } } }),
			isWindowMenuItemAllowed({ command: { id: 'git.blame.toggleStatusBarItem', title: 'Toggle Git Blame Status Bar Item', source: { id: 'vscode.git', title: 'Git' } } })
		], [true, true, false, true]);
	});

	test('filters existing and late menu registrations, implicit palette items, submenus and alternatives', () => {
		const menu = MenuId.for('outscaled.test.chrome');
		store.add(MenuRegistry.appendMenuItem(menu, { command: { id: 'github.copilot.test', title: 'Copilot' } }));
		store.add(registerMenuItemFilter(isWindowMenuItemAllowed));
		store.add(MenuRegistry.appendMenuItem(menu, { command: { id: 'test.chrome.allowed', title: 'Find in Files' } }));
		store.add(MenuRegistry.appendMenuItem(menu, { command: { id: 'test.chrome.localized', source: { id: 'test.extension', title: 'Test Extension' }, title: { value: 'Translated', original: 'Sign In' } } }));
		store.add(MenuRegistry.appendMenuItem(menu, { title: 'Activity Bar Position', submenu: MenuId.ActivityBarPositionMenu }));
		store.add(MenuRegistry.appendMenuItem(menu, { command: { id: 'test.chrome.alt', title: 'Action' }, alt: { id: 'chat.open', title: 'Chat' } }));
		store.add(MenuRegistry.appendMenuItem(menu, { command: { id: 'test.chrome.category', source: { id: 'test.extension', title: 'Test Extension' }, title: 'Clear', category: { value: 'Translated', original: 'Chat' } } }));
		store.add(MenuRegistry.addCommand({ id: 'test.chrome.implicit', source: { id: 'test.extension', title: 'Test Extension' }, title: 'Use AI Features' }));
		assert.deepStrictEqual(MenuRegistry.getMenuItems(menu), [{ command: { id: 'test.chrome.allowed', title: 'Find in Files' } }]);
		assert.strictEqual(MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === 'test.chrome.implicit'), false);
	});

	test('hidden commands remain callable internally', () => {
		store.add(registerMenuItemFilter(isWindowMenuItemAllowed));
		let executed = false;
		store.add(CommandsRegistry.registerCommand('workbench.action.chat.testInternal', () => { executed = true; }));
		store.add(MenuRegistry.addCommand({ id: 'workbench.action.chat.testInternal', title: 'Internal Chat Action' }));
		const accessor = store.add(new TestInstantiationService());
		CommandsRegistry.getCommand('workbench.action.chat.testInternal')!.handler(accessor);
		assert.deepStrictEqual({ executed, presented: MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === 'workbench.action.chat.testInternal') }, { executed: true, presented: false });
	});

	test('discards persisted chat editors before creating an editor input', () => {
		const instantiation = store.add(new TestInstantiationService());
		const create = spy(instantiation, 'createInstance');
		try {
			const restored = new ChatEditorInputSerializer().deserialize(instantiation, JSON.stringify({ resource: URI.parse('vscode-chat-editor:/fixture') }));
			assert.deepStrictEqual({ restored, created: create.called }, { restored: undefined, created: false });
		} finally {
			create.restore();
		}
	});

	test('product policies override user, workspace, resource and language values and survive policy refresh', () => {
		const log = store.add(new NullLogService());
		const empty = () => ConfigurationModel.createEmptyModel(log);
		const user = empty();
		user.setValue('chat.disableAIFeatures', false);
		user.setValue('workbench.statusBar.visible', true);
		user.setValue('editor.fontSize', 17);
		const workspace = empty();
		workspace.setValue('chat.disableAIFeatures', false);
		workspace.setValue('[typescript]', { 'chat.disableAIFeatures': false, 'workbench.statusBar.visible': true });
		const configuration = new Configuration(empty(), empty(), empty(), user, empty(), workspace, new ResourceMap(), empty(), new ResourceMap(), log);
		configuration.updateValue('chat.disableAIFeatures', false, { resource: URI.file('/fixture/file.ts') });
		const read = () => ({
			ai: configuration.getValue('chat.disableAIFeatures', { resource: URI.file('/fixture/file.ts'), overrideIdentifier: 'typescript' }, undefined),
			bar: configuration.inspect('workbench.statusBar.visible', {}, undefined).policyValue,
			ordinary: configuration.getValue('editor.fontSize', {}, undefined)
		});
		const before = read();
		configuration.compareAndUpdatePolicyConfiguration(empty());
		assert.deepStrictEqual([before, read()], [{ ai: true, bar: false, ordinary: 17 }, { ai: true, bar: false, ordinary: 17 }]);
	});
});
