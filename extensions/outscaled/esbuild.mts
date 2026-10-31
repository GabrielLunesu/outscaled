/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { spawnTsgo } from '../../build/lib/tsgo.ts';
import { run } from '../esbuild-extension-common.mts';

const extensionDir = import.meta.dirname;

// Bundle the shared TypeScript source and zod for both self-hosting and packaging.
await run({
	platform: 'node',
	entryPoints: {
		extension: path.join(extensionDir, 'src/extension.ts'),
	},
	srcDir: path.join(extensionDir, 'src'),
	outdir: path.join(extensionDir, 'dist'),
	additionalOptions: {
		alias: { zod: path.join(extensionDir, 'node_modules/zod') },
	},
	additionalWatchPaths: [
		path.join(extensionDir, '../../protocol/src'),
		path.join(extensionDir, 'tsconfig.json'),
	],
	beforeBuild: () => spawnTsgo(path.join(extensionDir, 'tsconfig.json'), { taskName: 'outscaled', noEmit: true }),
}, process.argv);
