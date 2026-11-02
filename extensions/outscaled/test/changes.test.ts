/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gabriel Lunesu. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Uri } from 'vscode';
import { changeEditor, ChangesRepository, commitChanges, changesErrorMessage } from '../src/grid/changes';
import { AgentChangedFile, AgentsWorkspace, isAgentsRequest } from '../../../src/vs/workbench/contrib/outscaled/common/agentsBridge.js';

const workspace: AgentsWorkspace = { id: 'w', name: 'demo', server: 'local', root: 'file:///test/repo/subfolder', online: true, selected: true, terminals: [], layout: { type: 'pane', terminal: null } };
const file: AgentChangedFile = { path: 'new.ts', originalPath: null, status: 'modified', agents: [] };
const api = { toGitUri: (uri: Uri, ref: string) => uri.with({ scheme: 'git', query: ref }) };

test('HEAD diff uses old path for rename and empty sides for additions, untracked files and deletions', () => {
	const descriptors = (['modified', 'added', 'untracked', 'deleted', 'renamed'] as const).map(status => changeEditor(api, workspace, { ...file, status, originalPath: status === 'renamed' ? 'old.ts' : null }));
	assert.deepEqual(descriptors.map(editor => [Uri.parse(editor.original!).scheme, Uri.parse(editor.original!).path, Uri.parse(editor.modified).scheme]), [
		['git', '/test/repo/subfolder/new.ts', 'file'], ['outscaled-empty', '/new.ts', 'file'], ['outscaled-empty', '/new.ts', 'file'],
		['git', '/test/repo/subfolder/new.ts', 'outscaled-empty'], ['git', '/test/repo/subfolder/old.ts', 'file']
	]);
	assert.equal(Uri.parse(descriptors[0].original!).query, 'HEAD');
	assert.deepEqual(changeEditor(api, { ...workspace, root: 'ws://example/demo/' }, file), { modified: 'ws://example/demo/new.ts', label: 'new.ts' });
});

test('commits every displayed file and rename source through Git API with no follow-up command', async () => {
	const calls: object[] = [];
	const repository: ChangesRepository = { rootUri: Uri.file('/test/repo'), state: { indexChanges: [] },
		status: async () => { calls.push({ status: true }); }, add: async paths => { calls.push({ add: paths }); repository.state.indexChanges = paths.map(path => ({ uri: Uri.file(path) })); }, commit: async (message, options) => { calls.push({ message, options }); } };
	await commitChanges(repository, Uri.parse(workspace.root), { attributionAvailable: true, files: [file, { ...file, path: 'renamed.ts', originalPath: 'old.ts', status: 'renamed' }] }, ['new.ts', 'renamed.ts'], '  Commit files  ');
	assert.deepEqual(calls, [{ status: true }, { add: ['/test/repo/subfolder/new.ts', '/test/repo/subfolder/renamed.ts', '/test/repo/subfolder/old.ts'] }, { status: true }, { message: 'Commit files', options: { all: false, postCommitCommand: null } }]);
});

test('empty, stale, remote and unrelated staged changes never commit; git failures propagate', async () => {
	let committed = false;
	const repository: ChangesRepository = { rootUri: Uri.file('/test/repo'), state: { indexChanges: [] }, status: async () => {}, add: async paths => { repository.state.indexChanges = paths.map(path => ({ uri: Uri.file(path) })); }, commit: async () => { committed = true; } };
	const changes = { attributionAvailable: true, files: [file] };
	for (const message of ['', ' \n ', 'bad\0message']) { await assert.rejects(commitChanges(repository, Uri.parse(workspace.root), changes, ['new.ts'], message)); }
	for (const paths of [[], ['stale.ts'], ['new.ts', 'new.ts']]) { await assert.rejects(commitChanges(repository, Uri.parse(workspace.root), changes, paths, 'message')); }
	await assert.rejects(commitChanges(repository, Uri.parse('ws://example/demo/'), changes, ['new.ts'], 'message'), /VPS/);
	repository.state.indexChanges = [{ uri: Uri.file('/test/repo/outside.ts') }];
	await assert.rejects(commitChanges(repository, Uri.parse(workspace.root), changes, ['new.ts'], 'message'), /already staged/);
	assert.equal(committed, false);
	repository.state.indexChanges = [];
	const stage = repository.add; repository.add = async () => {};
	await assert.rejects(commitChanges(repository, Uri.parse(workspace.root), changes, ['new.ts'], 'message'), /No changes to commit/);
	repository.add = stage;
	repository.commit = async () => { throw new Error('Git hook failed'); };
	await assert.rejects(commitChanges(repository, Uri.parse(workspace.root), changes, ['new.ts'], 'message'), /Git hook failed/);
});

test('commit request validation is shared by the extension command boundary', () => {
	const request = { version: 1, action: 'commitChanges', workspace: 'w', paths: ['new.ts'], message: 'message' };
	assert.equal(isAgentsRequest(request), true);
	for (const invalid of [{ message: '' }, { paths: [] }, { paths: ['../outside'] }, { paths: ['new.ts', 'new.ts'] }, { workspace: 1 }]) { assert.equal(isAgentsRequest({ ...request, ...invalid }), false); }
});

test('Git stderr is presented alongside the short error, without repeating it', () => {
	assert.deepEqual([changesErrorMessage(Object.assign(new Error('Commit failed'), { stderr: 'Hook rejected commit\n' })), changesErrorMessage(new Error('Git failed')), changesErrorMessage('Offline')],
		['Commit failed\nHook rejected commit', 'Git failed', 'Offline']);
});
