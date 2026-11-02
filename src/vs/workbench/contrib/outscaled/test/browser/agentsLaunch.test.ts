/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual, throws } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { defaultLaunch, insertLaunch, isAgentsLaunch, launchNames, parseAgentsCommand } from '../../common/agentsLaunch.js';
import { layoutTerminals, presetLayout } from '../../common/agentsLayout.js';

suite('Outscaled - New Agents', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('parses layouts, counts, mixes, placement and run examples', () => {
		const cases: [string, object][] = [
			['2x2 claude', { layout: '2x2', agents: ['claude', 'claude', 'claude', 'claude'] }],
			['four across codex', { layout: 'four-across', agents: ['codex', 'codex', 'codex', 'codex'] }],
			['side by side', { layout: 'side-by-side', agents: ['claude', 'claude'] }],
			['stacked shell', { layout: 'stacked', agents: ['shell', 'shell'] }],
			['claude', {}], ['4 codex', { layout: '2x2', agents: ['codex', 'codex', 'codex', 'codex'] }],
			['2 claude 2 codex', { layout: '2x2', agents: ['claude', 'claude', 'codex', 'codex'] }],
			['claude + shell', { layout: 'side-by-side', agents: ['claude', 'shell'] }],
			['claude and codex', { layout: 'side-by-side', agents: ['claude', 'codex'] }],
			['codex right', { agents: ['codex'], where: 'right' }], ['claude below', { where: 'below' }],
			['claude add', { where: 'add' }], ['claude replace', {}],
			['claude always on', { run: 'always' }], ['claude always', { run: 'always' }],
			['claude every 30m', { run: 'scheduled', interval: '30m' }],
			['claude every 2h', { run: 'scheduled', interval: '2h' }], ['claude every 1d', { run: 'scheduled', interval: '1d' }],
			['  2X2   CLAUDE  ', { layout: '2x2', agents: ['claude', 'claude', 'claude', 'claude'] }]
		];
		deepStrictEqual(cases.map(([input]) => parseAgentsCommand(input)), cases.map(([, overrides]) => ({ choices: { ...defaultLaunch(), ...overrides }, understood: true, ignored: [] })));
	});
	test('reports junk and partial input without executing or inventing commands', () => {
		deepStrictEqual(['', 'junk', 'clau', '2x', 'every', '0 codex', '99 claude'].map(input => {
			const parsed = parseAgentsCommand(input); return { understood: parsed.understood, ignored: parsed.ignored };
		}), [
			{ understood: false, ignored: [] }, { understood: false, ignored: ['junk'] }, { understood: false, ignored: ['clau'] },
			{ understood: false, ignored: ['2x'] }, { understood: false, ignored: ['every'] }, { understood: false, ignored: ['0', 'codex'] }, { understood: false, ignored: ['99', 'claude'] }
		]);
		deepStrictEqual(parseAgentsCommand('codex nonsense every').ignored, ['nonsense', 'every']);
		strictEqual(parseAgentsCommand('4 claude 4 codex').understood, false);
	});
	test('validates every choice at the boundary', () => {
		strictEqual(isAgentsLaunch(defaultLaunch()), true);
		for (const choices of [{ agents: [] }, { layout: 'bad' }, { agents: ['bash'] }, { interval: '0m' }, { interval: '1s' }, { prompt: '\0' }, { prompt: 42 }, { run: 'exec' }, { where: 'left' }]) { strictEqual(isAgentsLaunch({ ...defaultLaunch(), ...choices }), false); }
	});
	test('allocates free names and inserts split trees without losing old identities', () => {
		deepStrictEqual(launchNames(['claude', 'codex', 'shell', 'claude'], ['claude-1', 'claude-3', 'codex-1']), ['claude-2', 'codex-2', 'shell-1', 'claude-4']);
		const tree = presetLayout('stacked', ['a', 'b']); const added = presetLayout('side-by-side', ['c', 'd']);
		deepStrictEqual(insertLaunch(tree, added, 'replace'), added);
		deepStrictEqual(insertLaunch(tree, added, 'add'), { type: 'split', direction: 'right', children: [tree, added] });
		deepStrictEqual(insertLaunch(tree, added, 'right', 'a'), { type: 'split', direction: 'down', children: [{ type: 'split', direction: 'right', children: [{ type: 'pane', terminal: 'a' }, added] }, { type: 'pane', terminal: 'b' }] });
		deepStrictEqual(layoutTerminals(insertLaunch(tree, added, 'below', 'b')), ['a', 'b', 'c', 'd']);
		deepStrictEqual(layoutTerminals(tree), ['a', 'b']);
		throws(() => insertLaunch(tree, added, 'right', 'missing'));
	});
});
