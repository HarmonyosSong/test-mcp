import assert from 'node:assert/strict';
import test from 'node:test';

import { GitLabArchiveClient, GitLabArchiveError } from '../src/capabilities/gitlab-archive.js';

const COMMIT = 'b'.repeat(40);

test('GitLab tag 查询读取后续页并验证 commit 身份', async () => {
  const pages: string[] = [];
  const client = new GitLabArchiveClient({
    baseUrl: 'https://git.example.test', token: 'fixture',
    fetchImpl: async (input) => {
      const page = new URL(String(input)).searchParams.get('page')!;
      pages.push(page);
      return Response.json([{ name: `release-${page}`, commit: { id: COMMIT } }], {
        headers: { 'x-next-page': page === '1' ? '2' : '' },
      });
    },
  });
  assert.equal((await client.searchTags('group/ios', '5.105.0')).length, 2);
  assert.deepEqual(pages, ['1', '2']);
  const invalid = new GitLabArchiveClient({
    baseUrl: 'https://git.example.test', token: 'fixture',
    fetchImpl: async () => Response.json([{ name: 'release', commit: { id: 'main' } }]),
  });
  await assert.rejects(() => invalid.searchTags('group/ios', '5.105.0'), /固定 commit/);
});

test('GitLab archive client 先校验 commit，再下载固定 SHA archive，且不泄露 token', async () => {
  const requests: Array<{ url: string; token: string | null }> = [];
  const client = new GitLabArchiveClient({
    baseUrl: 'https://git.example.test',
    token: 'private-test-token',
    fetchImpl: async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({ url, token: headers?.['PRIVATE-TOKEN'] ?? null });
      if (url.includes('/commits/')) {
        return new Response(JSON.stringify({ id: COMMIT, short_id: COMMIT.slice(0, 8), committed_date: null }), { status: 200 });
      }
      return new Response(new Uint8Array([31, 139, 8, 0]), { status: 200 });
    },
  });
  const result = await client.downloadArchive('group/app', COMMIT);
  assert.equal(result.commit.id, COMMIT);
  assert.deepEqual([...result.archive], [31, 139, 8, 0]);
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.url, /projects\/group%2Fapp\/repository\/commits\//);
  assert.match(requests[1]!.url, /archive\.tar\.gz\?sha=/);
  assert.equal(requests[0]!.token, 'private-test-token');
});

test('GitLab archive client 拒绝非法 commit 和不匹配的 commit 响应', async () => {
  await assert.rejects(
    () => new GitLabArchiveClient({ baseUrl: 'https://git.example.test', token: 'token' }).verifyCommit('group/app', 'bad'),
    (error: unknown) => error instanceof GitLabArchiveError && error.code === 'invalid_commit',
  );
  const client = new GitLabArchiveClient({
    baseUrl: 'https://git.example.test',
    token: 'token',
    fetchImpl: async () => new Response(JSON.stringify({ id: 'c'.repeat(40), short_id: 'cccccccc' }), { status: 200 }),
  });
  await assert.rejects(
    () => client.verifyCommit('group/app', 'b'.repeat(40)),
    (error: unknown) => error instanceof GitLabArchiveError && error.code === 'invalid_response',
  );
});
