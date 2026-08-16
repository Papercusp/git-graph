/**
 * @vitest-environment jsdom
 *
 * Tests for the git-log cache: in-memory + localStorage caching, the defensive
 * refs/parents string→array normalization, error propagation, and in-flight dedup.
 * Run with: npx vitest run libs/generic/git-graph/src/cache.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachedGitLog, fetchGitLog } from './cache';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// The jsdom localStorage in this config is a partial shim (no .clear); install a
// real in-memory Storage stub on globalThis (cf. operator-vitest-localstorage-stub).
const lsStore = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)); },
  removeItem: (k: string) => { lsStore.delete(k); },
  clear: () => lsStore.clear(),
  key: (i: number) => [...lsStore.keys()][i] ?? null,
  get length() { return lsStore.size; },
});

beforeEach(() => {
  fetchMock.mockReset();
  lsStore.clear();
});

const jsonResp = (body: unknown) => ({ json: async () => body });

describe('fetchGitLog', () => {
  it('fetches, returns commits, and serves them from the in-memory cache after', async () => {
    fetchMock.mockResolvedValue(jsonResp({ commits: [{ id: 'a', refs: [], parents: [] }] }));
    const out = await fetchGitLog('mem-scope', 10, '/url');
    expect(out).toEqual([{ id: 'a', refs: [], parents: [] }]);
    expect(getCachedGitLog('mem-scope', 10)).toEqual(out);
  });

  it('normalizes comma-separated refs and space-separated parents (drifted-backend defense)', async () => {
    fetchMock.mockResolvedValue(jsonResp({ commits: [{ id: 'a', refs: 'main, origin/main', parents: 'p1 p2' }] }));
    const [commit] = await fetchGitLog('norm-scope', 10, '/url');
    expect(commit.refs).toEqual(['main', 'origin/main']);
    expect(commit.parents).toEqual(['p1', 'p2']);
  });

  it('defaults missing refs/parents to empty arrays', async () => {
    fetchMock.mockResolvedValue(jsonResp({ commits: [{ id: 'a' }] }));
    const [commit] = await fetchGitLog('default-scope', 10, '/url');
    expect(commit.refs).toEqual([]);
    expect(commit.parents).toEqual([]);
  });

  it('throws on an { error } response', async () => {
    fetchMock.mockResolvedValue(jsonResp({ error: 'git failed' }));
    await expect(fetchGitLog('err-scope', 10, '/url')).rejects.toThrow('git failed');
  });

  it('dedupes concurrent in-flight requests for the same key', async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const p1 = fetchGitLog('flight-scope', 10, '/url');
    const p2 = fetchGitLog('flight-scope', 10, '/url');
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call rode the in-flight promise
    resolve(jsonResp({ commits: [] }));
    await Promise.all([p1, p2]);
  });
});

describe('getCachedGitLog', () => {
  it('returns null when nothing is cached', () => {
    expect(getCachedGitLog('cold-scope', 10)).toBeNull();
  });

  it('reads back from localStorage when not in the memory cache', () => {
    // storageKey format: gitlog.<scope>.<limit>.<ref|_all sanitized>
    localStorage.setItem('gitlog.ls-scope.10._all', JSON.stringify([{ id: 'x', refs: [], parents: [] }]));
    expect(getCachedGitLog('ls-scope', 10)).toEqual([{ id: 'x', refs: [], parents: [] }]);
  });

  it('ignores malformed localStorage values', () => {
    localStorage.setItem('gitlog.bad-scope.10._all', 'not json');
    expect(getCachedGitLog('bad-scope', 10)).toBeNull();
  });
});
