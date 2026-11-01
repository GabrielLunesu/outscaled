/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IHostService, IToastOptions, IToastResult } from '../../../../services/host/browser/host.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { showNotification } from '../../browser/notifications.js';

class TestHostService extends mock<IHostService>() {
	readonly toasts: IToastOptions[] = [];
	readonly completion = new DeferredPromise<IToastResult>();
	readonly focusCalls: { targetWindow: Window; mode: FocusMode | undefined }[] = [];

	override async showToast(options: IToastOptions, token: CancellationToken): Promise<IToastResult> {
		strictEqual(token.isCancellationRequested, false);
		this.toasts.push(options);
		return this.completion.p;
	}

	override async focus(targetWindow: Window, options?: { mode?: FocusMode }): Promise<void> {
		this.focusCalls.push({ targetWindow, mode: options?.mode });
	}
}

class TestTerminal extends mock<ITerminalInstance>() {
	override isDisposed = false;

	constructor(
		override readonly processId: number,
		override readonly target: TerminalLocation
	) {
		super();
	}
}

class TestTerminalService extends mock<ITerminalService>() {
	override instances: ITerminalInstance[] = [];
	readonly focused: ITerminalInstance[] = [];

	constructor(private readonly host: TestHostService) {
		super();
	}

	override async focusInstance(instance: ITerminalInstance): Promise<void> {
		deepStrictEqual(this.host.focusCalls, [{ targetWindow: mainWindow, mode: FocusMode.Force }]);
		this.focused.push(instance);
	}
}

suite('Outscaled - Notifications', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const request = { id: 'terminal-200', title: 'Needs You', body: 'Permission requested', processId: 200 };

	test('rejects malformed arguments without showing or focusing anything', async () => {
		const host = new TestHostService();
		const terminals = new TestTerminalService(host);
		const invalidRequests: unknown[] = [
			undefined, null, false, 1, 'notification', [], {},
			{ ...request, id: undefined }, { ...request, id: '' }, { ...request, id: ' ' }, { ...request, id: 123 },
			{ ...request, title: undefined }, { ...request, title: '' }, { ...request, title: ' ' }, { ...request, title: 123 },
			{ ...request, body: undefined }, { ...request, body: null }, { ...request, body: 123 },
			...[-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '200', null].map(processId => ({ ...request, processId }))
		];
		for (const invalidRequest of invalidRequests) {
			deepStrictEqual(await showNotification(host, terminals, invalidRequest), { shown: false, clicked: false });
		}
		deepStrictEqual([host.toasts, host.focusCalls, terminals.focused], [[], [], []]);
	});

	test('waits for dismissal and forwards the notification content', async () => {
		const host = new TestHostService();
		const terminals = new TestTerminalService(host);
		let settled = false;
		const pending = showNotification(host, terminals, request).then(result => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		strictEqual(settled, false);
		deepStrictEqual(host.toasts, [{ dedupeKey: request.id, title: request.title, body: request.body }]);
		await host.completion.complete({ supported: true, clicked: false });
		deepStrictEqual(await pending, { shown: true, clicked: false });
		deepStrictEqual([host.focusCalls, terminals.focused], [[], []]);
	});

	test('unsupported and suppressed toasts are not shown and never focus', async () => {
		for (const toastResult of [
			{ supported: false, clicked: false },
			{ supported: true, suppressed: true, clicked: false }
		]) {
			const host = new TestHostService();
			const terminals = new TestTerminalService(host);
			await host.completion.complete(toastResult);
			deepStrictEqual(await showNotification(host, terminals, request), { shown: false, clicked: false });
			deepStrictEqual([host.focusCalls, terminals.focused], [[], []]);
		}
	});

	for (const target of [TerminalLocation.Panel, TerminalLocation.Editor]) {
		test(`click forces the window forward and focuses the matching ${target === TerminalLocation.Panel ? 'panel' : 'editor'} terminal`, async () => {
			const host = new TestHostService();
			const terminals = new TestTerminalService(host);
			const first = new TestTerminal(100, TerminalLocation.Panel);
			const second = new TestTerminal(200, target);
			terminals.instances = [first, second];
			const pending = showNotification(host, terminals, request);
			deepStrictEqual([host.focusCalls, terminals.focused], [[], []]);
			await host.completion.complete({ supported: true, clicked: true });
			deepStrictEqual(await pending, { shown: true, clicked: true });
			deepStrictEqual(terminals.focused, [second]);
		});
	}

	test('a click without a process id still focuses the window', async () => {
		const host = new TestHostService();
		const terminals = new TestTerminalService(host);
		await host.completion.complete({ supported: true, clicked: true });
		deepStrictEqual(await showNotification(host, terminals, { id: 'workspace', title: 'Needs You', body: '' }), { shown: true, clicked: true });
		deepStrictEqual(host.focusCalls, [{ targetWindow: mainWindow, mode: FocusMode.Force }]);
		deepStrictEqual(terminals.focused, []);
	});

	test('a missing or disposed terminal does not prevent the clicked result or window focus', async () => {
		for (const disposed of [false, true]) {
			const host = new TestHostService();
			const terminals = new TestTerminalService(host);
			const second = new TestTerminal(200, TerminalLocation.Editor);
			terminals.instances = [second];
			const pending = showNotification(host, terminals, request);
			if (disposed) {
				second.isDisposed = true;
			} else {
				terminals.instances = [];
			}
			await host.completion.complete({ supported: true, clicked: true });
			deepStrictEqual(await pending, { shown: true, clicked: true });
			deepStrictEqual(host.focusCalls, [{ targetWindow: mainWindow, mode: FocusMode.Force }]);
			deepStrictEqual(terminals.focused, []);
		}
	});
});
