import type { Commit } from './graphLayout';

interface Entry {
  data: Commit[] | null;
  ts: number;
  inFlight?: Promise<Commit[]>;
}

const cache = new Map<string, Entry>();

function cacheKey(scope: string, limit: number) { return `${scope}:${limit}`; }
function storageKey(scope: string, limit: number) { return `gitlog.${scope}.${limit}`; }

function readStorage(scope: string, limit: number): Commit[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(scope, limit));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Commit[];
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function writeStorage(scope: string, limit: number, commits: Commit[]) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(storageKey(scope, limit), JSON.stringify(commits)); } catch {}
}

export function getCachedGitLog(scope: string, limit: number): Commit[] | null {
  const hit = cache.get(cacheKey(scope, limit))?.data;
  if (hit) return hit;
  const persisted = readStorage(scope, limit);
  if (persisted) cache.set(cacheKey(scope, limit), { data: persisted, ts: 0 });
  return persisted;
}

/**
 * Fetch git log via the provided URL. The response must shape `{ commits: Commit[] }`
 * or `{ error: string }`.
 */
export function fetchGitLog(scope: string, limit: number, url: string): Promise<Commit[]> {
  const k = cacheKey(scope, limit);
  const existing = cache.get(k);
  if (existing?.inFlight) return existing.inFlight;

  const p = fetch(url)
    .then((r) => r.json())
    .then((d) => {
      if (d.error) throw new Error(d.error);
      const commits = (d.commits ?? []) as Commit[];
      cache.set(k, { data: commits, ts: Date.now() });
      writeStorage(scope, limit, commits);
      return commits;
    })
    .catch((e) => {
      const cur = cache.get(k);
      if (cur) cache.set(k, { ...cur, inFlight: undefined });
      throw e;
    });

  cache.set(k, { data: existing?.data ?? null, ts: existing?.ts ?? 0, inFlight: p });
  return p;
}

export function preloadGitLog(scope: string, limit: number, url: string) {
  fetchGitLog(scope, limit, url).catch(() => {});
}
