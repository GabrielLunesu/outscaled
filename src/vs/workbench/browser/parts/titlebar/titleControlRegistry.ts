/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { SyncDescriptor0 } from '../../../../platform/instantiation/common/descriptors.js';

export interface ITitleControl extends IDisposable { readonly element: HTMLElement }
let titleControl: SyncDescriptor0<ITitleControl> | undefined;

/** Register before the workbench creates its titlebar. */
export function registerTitleControl(descriptor: SyncDescriptor0<ITitleControl>): void { titleControl = descriptor; }

/** Optional product control; stock windows fall back to the command center. */
export function getTitleControl(): SyncDescriptor0<ITitleControl> | undefined { return titleControl; }
