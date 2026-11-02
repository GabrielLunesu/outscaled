/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentsLayout, isAgentsLayout, layoutIds, layoutTerminals, presetLayout, reconcileLayout, removePane, sameLayoutStructure, splitPane, splitSizes } from '../../common/agentsLayout.js';

suite('Outscaled - Agents Layout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('six presets have the specified geometry and fill order', () => {
		const rectangles = (tree: AgentsLayout, box = [0, 0, 1, 1]): number[][] => {
			if (tree.type === 'pane') { return [box]; }
			return tree.children.flatMap((child, index) => {
				const [x, y, width, height] = box;
				return rectangles(child, tree.direction === 'right' ? [x + width * index / tree.children.length, y, width / tree.children.length, height]
					: [x, y + height * index / tree.children.length, width, height / tree.children.length]);
			});
		};
		deepStrictEqual(layoutIds.map(id => rectangles(presetLayout(id, ['1', '2', '3', '4']))), [
			[[0, 0, 1, 1]], [[0, 0, .5, 1], [.5, 0, .5, 1]], [[0, 0, 1, .5], [0, .5, 1, .5]],
			[[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]],
			[[0, 0, .25, 1], [.25, 0, .25, 1], [.5, 0, .25, 1], [.75, 0, .25, 1]],
			[[0, 0, .5, .5], [0, .5, .5, .5], [.5, 0, .5, 1]]
		]);
		deepStrictEqual(layoutIds.map(id => layoutTerminals(presetLayout(id, ['1', '2', '3', '4']))),
			[['1'], ['1', '2'], ['1', '2'], ['1', '2', '3', '4'], ['1', '2', '3', '4'], ['1', '2', '3']]);
	});
	test('split any pane right or below without changing existing membership', () => {
		const tree = presetLayout('2+1', ['a', 'b', 'c']);
		for (const direction of ['right', 'down'] as const) {
			const result = splitPane(tree, 'b', 'd', direction);
			deepStrictEqual(layoutTerminals(result), ['a', 'b', 'd', 'c']);
			strictEqual(isAgentsLayout(result), true);
		}
		deepStrictEqual(layoutTerminals(tree), ['a', 'b', 'c']);
		deepStrictEqual(reconcileLayout(tree, new Set(['a', 'c', 'replacement'])), {
			type: 'split', direction: 'right', children: [{ type: 'split', direction: 'down', children: [{ type: 'pane', terminal: 'a' }, { type: 'pane', terminal: null }] }, { type: 'pane', terminal: 'c' }]
		});
	});
	test('split right and below at every depth preserves ancestor weights and resets the new split', () => {
		const a = presetLayout('single', ['a']);
		const b = presetLayout('single', ['b']);
		const c = presetLayout('single', ['c']);
		const nested: AgentsLayout = { type: 'split', direction: 'down', children: [a, b], sizes: [2, 1] };
		const tree: AgentsLayout = { type: 'split', direction: 'right', children: [nested, c], sizes: [1, 3] };
		for (const direction of ['right', 'down'] as const) {
			for (const terminal of ['a', 'b', 'c']) {
				const result = splitPane(tree, terminal, 'new', direction);
				const replace = (node: AgentsLayout): AgentsLayout => node.type === 'pane'
					? node.terminal === terminal ? { type: 'split', direction, children: [node, { type: 'pane', terminal: 'new' }] } : node
					: { ...node, children: node.children.map(replace) };
				deepStrictEqual(result, replace(tree));
			}
		}
		deepStrictEqual(splitPane(tree, 'missing', 'new', 'right'), tree);
	});

	test('remove collapses single-child splits and resets only splits losing a child', () => {
		const a = presetLayout('single', ['a']);
		const b = presetLayout('single', ['b']);
		const c = presetLayout('single', ['c']);
		const nested: AgentsLayout = { type: 'split', direction: 'down', children: [a, b], sizes: [2, 1] };
		const tree: AgentsLayout = { type: 'split', direction: 'right', children: [nested, c], sizes: [1, 3] };
		deepStrictEqual(removePane(tree, 'a'), { ...tree, children: [b, c] });
		deepStrictEqual(removePane(tree, 'c'), nested);
		deepStrictEqual(removePane(removePane(tree, 'c'), 'b'), a);
		deepStrictEqual(removePane(a, 'a'), { type: 'pane', terminal: null });
		deepStrictEqual(removePane(tree, 'missing'), tree);
		deepStrictEqual(removePane({ type: 'split', direction: 'right', children: [a, b, c], sizes: [2, 3, 1] }, 'b'),
			{ type: 'split', direction: 'right', children: [a, c] });
	});

	test('old trees migrate to equal weights, resize weights normalize, and malformed sizes fail', () => {
		const old = presetLayout('side-by-side', ['a', 'b']);
		if (old.type !== 'split') { throw new Error('Expected a split'); }
		deepStrictEqual([isAgentsLayout(old), splitSizes(old), splitSizes({ ...old, sizes: [3, 1] })], [true, [.5, .5], [.75, .25]]);
		for (const sizes of [[], [1], [1, 1, 1], [0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [Number.MAX_VALUE, Number.MAX_VALUE], ['1', 1]]) {
			strictEqual(isAgentsLayout({ ...old, sizes }), false);
		}
		strictEqual(sameLayoutStructure(old, { ...old, sizes: [3, 1] }), true);
		strictEqual(sameLayoutStructure(old, { ...old, direction: 'down' }), false);
		strictEqual(sameLayoutStructure(old, splitPane(old, 'a', 'c', 'right')), false);
		deepStrictEqual(reconcileLayout({ ...old, sizes: [3, 1] }, new Set(['a', 'b'])), { ...old, sizes: [3, 1] });
	});

});
