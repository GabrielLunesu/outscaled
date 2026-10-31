/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalIcon } from '../../../../../platform/terminal/common/terminal.js';
import { ISetTerminalStatusRequest, TerminalStatusController } from '../../browser/terminalStatus.js';

class TestTerminal {
	isDisposed = false;
	changes = 0;

	constructor(
		readonly processId: number | undefined,
		public icon: TerminalIcon | undefined = Codicon.terminal,
		public color: string | undefined = undefined
	) { }

	async changeIcon(icon?: TerminalIcon): Promise<TerminalIcon | undefined> {
		strictEqual(icon !== undefined, true, 'must not open the icon picker');
		this.icon = icon;
		this.changes++;
		return icon;
	}

	async changeColor(color?: string, skipQuickPick?: boolean): Promise<string | undefined> {
		strictEqual(skipQuickPick, true, 'must not open the color picker, including on reset');
		this.color = color;
		this.changes++;
		return color;
	}
}

suite('Outscaled - Terminal Status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('updates a terminal in the combined panel/editor instance list and restores its first appearance', async () => {
		const controller = new TerminalStatusController();
		const panel = new TestTerminal(100);
		const originalIcon = URI.parse('file:///terminal-icon.svg');
		const editor = new TestTerminal(200, originalIcon, 'terminal.ansiBlue');
		const instances = [panel, editor];
		const observed = [];
		for (const status of ['working', 'needs_input', 'idle', 'crashed', null] as const) {
			const found = await controller.setStatus(instances, { processId: 200, status }, Codicon.terminal);
			observed.push({ found, icon: editor.icon, color: editor.color });
		}
		deepStrictEqual(observed, [
			{ found: true, icon: ThemeIcon.modify(Codicon.loading, 'spin'), color: 'terminal.ansiGreen' },
			{ found: true, icon: Codicon.circleFilled, color: 'terminal.ansiRed' },
			{ found: true, icon: Codicon.circleFilled, color: 'terminal.ansiBrightBlack' },
			{ found: true, icon: Codicon.close, color: 'terminal.ansiRed' },
			{ found: true, icon: originalIcon, color: 'terminal.ansiBlue' }
		]);
		strictEqual(panel.changes, 0);
	});

	test('reset clears an originally unset color and retains the first snapshot across cycles', async () => {
		const controller = new TerminalStatusController();
		const terminal = new TestTerminal(100);
		await controller.setStatus([terminal], { processId: 100, status: 'working' }, Codicon.terminal);
		await controller.setStatus([terminal], { processId: 100, status: null }, Codicon.terminal);
		deepStrictEqual([terminal.icon, terminal.color], [Codicon.terminal, undefined]);
		terminal.icon = Codicon.beaker;
		terminal.color = 'terminal.ansiYellow';
		await controller.setStatus([terminal], { processId: 100, status: 'crashed' }, Codicon.terminal);
		await controller.setStatus([terminal], { processId: 100, status: null }, Codicon.terminal);
		deepStrictEqual([terminal.icon, terminal.color], [Codicon.terminal, undefined]);
	});

	test('reset after reload or process id reuse leaves an unremembered instance alone', async () => {
		const controller = new TerminalStatusController();
		const terminal = new TestTerminal(100);
		await controller.setStatus([terminal], { processId: 100, status: 'working' }, Codicon.terminal);
		await new TerminalStatusController().setStatus([terminal], { processId: 100, status: null }, Codicon.terminal);
		const replacement = new TestTerminal(100, Codicon.beaker, 'terminal.ansiBlue');
		await controller.setStatus([replacement], { processId: 100, status: null }, Codicon.terminal);
		deepStrictEqual([terminal.icon, terminal.color, replacement.changes], [ThemeIcon.modify(Codicon.loading, 'spin'), 'terminal.ansiGreen', 0]);
	});

	test('rapid concurrent updates preserve call order', async () => {
		const controller = new TerminalStatusController();
		const terminal = new TestTerminal(100);
		await Promise.all((['working', 'needs_input', 'idle', 'crashed', null] as const).map(status =>
			controller.setStatus([terminal], { processId: 100, status }, Codicon.terminal)));
		deepStrictEqual([terminal.icon, terminal.color], [Codicon.terminal, undefined]);
	});

	test('uses the configured default icon when the terminal has no resolved icon yet', async () => {
		const controller = new TerminalStatusController();
		const terminal = new TestTerminal(100);
		terminal.icon = undefined;
		await controller.setStatus([terminal], { processId: 100, status: 'working' }, Codicon.beaker);
		await controller.setStatus([terminal], { processId: 100, status: null }, Codicon.beaker);
		strictEqual(terminal.icon, Codicon.beaker);
	});

	test('missing, disposed, and invalid targets do not change a terminal', async () => {
		const controller = new TerminalStatusController();
		const terminal = new TestTerminal(100);
		const disposed = new TestTerminal(200);
		disposed.isDisposed = true;
		const requests = [
			{ processId: 300, status: 'working' },
			{ processId: 200, status: 'working' },
			{ processId: undefined, status: 'working' },
			{ processId: 100, status: 'invalid' },
			{ processId: 0, status: 'working' },
			{ processId: 1.5, status: 'working' },
			null
		];
		for (const request of requests) {
			strictEqual(await controller.setStatus([terminal, disposed], request as ISetTerminalStatusRequest, Codicon.terminal), false);
		}
		strictEqual(terminal.changes + disposed.changes, 0);
	});
});
