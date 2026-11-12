const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;

export type GitLabArchiveClientOptions = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type GitLabCommit = {
  id: string;
  short_id: string;
  committed_date: string | null;
};

export class GitLabArchiveError extends Error {
  public constructor(
    readonly code: 'invalid_config' | 'invalid_commit' | 'commit_not_found' | 'archive_unavailable' | 'invalid_response',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'GitLabArchiveError';
  }
}

export class GitLabArchiveClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: GitLabArchiveClientOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch (error) {
      throw new GitLabArchiveError('invalid_config', 'GitLab base URL 无效', { cause: error });
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new GitLabArchiveError('invalid_config', 'GitLab base URL 必须是无凭据的 origin');
    }
    if (!options.token.trim()) throw new GitLabArchiveError('invalid_config', 'GitLab token 未配置');
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
      throw new GitLabArchiveError('invalid_config', 'GitLab API 超时必须是正整数');
    }
    this.baseUrl = parsed;
    this.token = options.token.trim();
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async verifyCommit(
    repositoryId: string,
    expectedCommit: string,
    signal?: AbortSignal,
  ): Promise<GitLabCommit> {
    this.assertCommit(expectedCommit);
    const response = await this.request(
      `/api/v4/projects/${encodeURIComponent(repositoryId)}/repository/commits/${expectedCommit}`,
      signal,
    );
    if (response.status === 404) {
      throw new GitLabArchiveError('commit_not_found', `GitLab 未找到 ${repositoryId}@${expectedCommit}`);
    }
    if (!response.ok) {
      throw new GitLabArchiveError('archive_unavailable', `GitLab commit 校验失败（HTTP ${response.status}）`);
    }
    const value = await this.json(response, 'commit');
    if (!isObject(value) || typeof value.id !== 'string' || value.id !== expectedCommit || typeof value.short_id !== 'string') {
      throw new GitLabArchiveError('invalid_response', 'GitLab commit 响应缺少一致的 commit 身份');
    }
    return {
      id: value.id,
      short_id: value.short_id,
      committed_date: typeof value.committed_date === 'string' ? value.committed_date : null,
    };
  }

  public async downloadArchive(
    repositoryId: string,
    expectedCommit: string,
    signal?: AbortSignal,
  ): Promise<{ commit: GitLabCommit; archive: Uint8Array }> {
    const commit = await this.verifyCommit(repositoryId, expectedCommit, signal);
    const path = `/api/v4/projects/${encodeURIComponent(repositoryId)}/repository/archive.tar.gz?sha=${encodeURIComponent(expectedCommit)}`;
    const response = await this.request(path, signal);
    if (!response.ok) {
      throw new GitLabArchiveError('archive_unavailable', `GitLab archive 下载失败（HTTP ${response.status}）`);
    }
    const archive = new Uint8Array(await response.arrayBuffer());
    if (archive.length === 0) throw new GitLabArchiveError('invalid_response', 'GitLab archive 为空');
    return { commit, archive };
  }

  private async request(path: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(new URL(path, this.baseUrl), {
        method: 'GET',
        headers: {
          Accept: 'application/json, application/gzip',
          'PRIVATE-TOKEN': this.token,
        },
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal.aborted) throw new GitLabArchiveError('archive_unavailable', 'GitLab API 请求已取消或超时', { cause: error });
      throw new GitLabArchiveError('archive_unavailable', 'GitLab API 请求失败', { cause: error });
    }
  }

  private async json(response: Response, label: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new GitLabArchiveError('invalid_response', `GitLab ${label} 响应不是有效 JSON`, { cause: error });
    }
  }

  private assertCommit(commit: string): void {
    if (!COMMIT_PATTERN.test(commit)) throw new GitLabArchiveError('invalid_commit', 'expected commit 格式无效');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
