import { fail, SafeError } from './core.mjs';

export const REPOSITORY = 'zfy06011/cs2-market-data';
const SHA = /^[a-f0-9]{40}$/;
const DATE_PATH = '\\d{4}/\\d{2}/\\d{2}';
const PATHS = [new RegExp(`^quotes/${DATE_PATH}/[0-9]+\\.jsonl$`),
  new RegExp(`^(runs|selection)/${DATE_PATH}/[0-9]+\\.json$`),
  new RegExp(`^state/${DATE_PATH}/[0-9TZ]+-[0-9]+-[0-9]{3}\\.json$`),
  /^index\/[0-9]+\.json$/, /^pool\/frozen-v1\.json$/];
export const allowedPath = p => typeof p === 'string' && PATHS.some(r => r.test(p));
export function appendDelta(existing, files) {
  if (!files.length || files.length > 10) fail('invalid_append');
  const paths = new Set(), delta = [];
  for (const f of files) {
    if (!allowedPath(f.path) || paths.has(f.path) || typeof f.content !== 'string' ||
        Buffer.byteLength(f.content) > 1000000) fail('write_path_or_size');
    paths.add(f.path);
    if (existing.has(f.path)) {
      if (existing.get(f.path) !== f.content) fail('append_conflict');
    } else delta.push(f);
  }
  return delta;
}
export class GitHubArchive {
  constructor({ token, fetcher = fetch, repository = REPOSITORY } = {}) {
    if (repository !== REPOSITORY || !token) fail('archive_auth_or_repository');
    this.token = token; this.fetcher = fetcher; this.tree = new Map(); this.head = null;
  }
  async api(route, method = 'GET', body = undefined) {
    let res;
    try {
      res = await this.fetcher(`https://api.github.com/repos/${REPOSITORY}${route ? '/' + route : ''}`, {
        method, redirect: 'error', headers: { Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000)
      });
    } catch { fail('archive_network'); }
    if (!res.ok) throw new SafeError('archive_http', res.status);
    try { return await res.json(); } catch { fail('archive_schema'); }
  }
  async load() {
    const repo = await this.api('');
    if (repo.full_name !== REPOSITORY || repo.private !== false || repo.default_branch !== 'main') fail('archive_identity');
    let ref;
    try { ref = await this.api('git/ref/heads/data'); }
    catch (e) { if (e.httpStatus !== 404) throw e; this.head = null; this.tree = new Map(); return; }
    if (!SHA.test(ref.object?.sha) || ref.object.type !== 'commit') fail('archive_schema');
    this.head = ref.object.sha;
    const commit = await this.api('git/commits/' + this.head);
    if (!SHA.test(commit.tree?.sha)) fail('archive_schema');
    this.baseTree = commit.tree.sha;
    const tree = await this.api('git/trees/' + this.baseTree + '?recursive=1');
    if (tree.truncated || !Array.isArray(tree.tree)) fail('archive_tree_incomplete');
    this.tree = new Map(tree.tree.filter(x => x.type !== 'tree').map(x => [x.path, x]));
  }
  paths(prefix) { return [...this.tree.keys()].filter(p => p.startsWith(prefix)).sort(); }
  async read(path) {
    if (!allowedPath(path)) fail('read_path');
    const entry = this.tree.get(path);
    if (!entry) return null;
    if (entry.mode !== '100644' || entry.type !== 'blob' || !SHA.test(entry.sha) || entry.size > 1000000) fail('archive_entry');
    const blob = await this.api('git/blobs/' + entry.sha);
    if (blob.encoding !== 'base64' || blob.size > 1000000 || typeof blob.content !== 'string') fail('archive_blob');
    return Buffer.from(blob.content, 'base64').toString('utf8');
  }
  async json(path) {
    const text = await this.read(path); if (text === null) return null;
    try { return JSON.parse(text); } catch { fail('archive_json'); }
  }
  async append(files, batchId) {
    if (!/^[0-9]+$/.test(batchId)) fail('invalid_batch');
    // Only new regular files; no delete, move, overwrite, branch selection or force push API.
    appendDelta(new Map(), files);
    const old = new Map();
    for (const file of files) if (this.tree.has(file.path)) old.set(file.path, await this.read(file.path));
    const delta = appendDelta(old, files); if (!delta.length) return false;
    const tree = await this.api('git/trees', 'POST', {
      ...(this.head ? { base_tree: this.baseTree } : {}),
      tree: delta.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content }))
    });
    if (!SHA.test(tree.sha)) fail('archive_schema');
    const commit = await this.api('git/commits', 'POST', {
      message: `data: append collection ${batchId}`, tree: tree.sha, parents: this.head ? [this.head] : []
    });
    if (!SHA.test(commit.sha)) fail('archive_schema');
    // GitHub rejects a stale parent: never auto-merge or force past another writer.
    if (this.head) await this.api('git/refs/heads/data', 'PATCH', { sha: commit.sha, force: false });
    else await this.api('git/refs', 'POST', { ref: 'refs/heads/data', sha: commit.sha });
    await this.load();
    for (const file of delta) if (await this.read(file.path) !== file.content) fail('archive_readback');
    return true;
  }
  capacity() {
    let bytes = 0; for (const entry of this.tree.values()) bytes += entry.size ?? 0;
    return { files: this.tree.size, currentTreeBytes: bytes, warning: bytes >= 100 * 1024 * 1024,
      note: 'Current data tree only; Git history and repository size require monthly review.' };
  }
}
