/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentsLayout, isAgentsLayout, layoutIds, layoutTerminals, presetLayout, reconcileLayout, splitPane } from '../../common/agentsLayout.js';

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
});
