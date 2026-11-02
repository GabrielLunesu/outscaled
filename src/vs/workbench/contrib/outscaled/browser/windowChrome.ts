/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, markAsSingleton } from '../../../../base/common/lifecycle.js';
import { registerMenuItemFilter } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { hiddenBarCommandIds, isWindowMenuItemAllowed } from './windowChromePolicy.js';

// Core defaults must precede extension scanning on the first launch of a profile.
// Product policies additionally prevent AI and the removed bars from being re-enabled.
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{ overrides: {
	'chat.disableAIFeatures': true,
	'workbench.activityBar.location': 'hidden',
	'workbench.statusBar.visible': false,
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'workbench.startupEditor': 'none'
} }]);

// Static registrations live for the lifetime of this workbench module.
markAsSingleton(registerMenuItemFilter(isWindowMenuItemAllowed));

/** Register after the workbench's bar actions so only their public toggle/focus IDs become no-ops. */
class WindowChrome extends Disposable {
	static readonly ID = 'outscaled.windowChrome';

	constructor() {
		super();
		for (const id of hiddenBarCommandIds) {
			this._register(CommandsRegistry.registerCommand(id, () => { }));
		}
	}
}

registerWorkbenchContribution2(WindowChrome.ID, WindowChrome, WorkbenchPhase.AfterRestored);
