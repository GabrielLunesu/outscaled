/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { build } from '../../../build/node_modules/esbuild/lib/main.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary = mkdtempSync(join(tmpdir(), 'outscaled-tests-'));
try {
	const outfile = join(temporary, 'daemon.test.cjs');
	await build({ entryPoints: [new URL('./daemon.test.ts', import.meta.url).pathname], outfile,
		bundle: true, platform: 'node', format: 'cjs',
		alias: { '@outscaled/protocol': resolve('..', '..', 'protocol/src/index.ts'), zod: resolve('node_modules/zod') } });
	const workspaceTests = join(temporary, 'workspaces.test.cjs');
	await build({ entryPoints: [new URL('./workspaces.test.ts', import.meta.url).pathname], outfile: workspaceTests,
		bundle: true, platform: 'node', format: 'cjs',
		alias: { vscode: new URL('./vscode.ts', import.meta.url).pathname, '@outscaled/protocol': resolve('..', '..', 'protocol/src/index.ts'), zod: resolve('node_modules/zod') } });
	const gridTests = join(temporary, 'grid.test.cjs');
	await build({ entryPoints: [new URL('./grid.test.ts', import.meta.url).pathname], outfile: gridTests,
		bundle: true, platform: 'node', format: 'cjs',
		alias: { vscode: new URL('./vscode.ts', import.meta.url).pathname, '@outscaled/protocol': resolve('..', '..', 'protocol/src/index.ts'), zod: resolve('node_modules/zod') } });
	const notificationTests = join(temporary, 'notifications.test.cjs');
	await build({ entryPoints: [new URL('./notifications.test.ts', import.meta.url).pathname], outfile: notificationTests,
		bundle: true, platform: 'node', format: 'cjs',
		alias: { vscode: new URL('./notificationsVscode.ts', import.meta.url).pathname, '@outscaled/protocol': resolve('..', '..', 'protocol/src/index.ts'), zod: resolve('node_modules/zod') } });
	const result = spawnSync(process.execPath, ['--test', outfile, workspaceTests, gridTests, notificationTests], { stdio: 'inherit' });
	process.exitCode = result.status ?? 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
