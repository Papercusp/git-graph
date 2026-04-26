'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { assignLanes, laneColor, type Commit, type LaidOutCommit } from './graphLayout';
import { CommitDetail } from './CommitDetail';
import { fetchGitLog, getCachedGitLog } from './cache';
import './git-graph.css';

const LIMITS = [100, 300, 500, 1000] as const;
type GitFilter = 'all' | 'refs' | 'merges' | 'bookmarked';

function formatAge(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function refClass(ref: string): string {
  if (ref === 'HEAD' || ref.startsWith('HEAD ->')) return 'head';
  if (ref.startsWith('tag: ')) return 'tag';
  return 'branch';
}

function refLabel(ref: string): string {
  return ref.replace(/^tag: /, '').replace(/^HEAD -> /, 'HEAD → ');
}

function matchesCommit(commit: LaidOutCommit, needle: string): boolean {
  if (!needle) return true;
  const haystack = [commit.sha, commit.subject, commit.author, ...commit.refs].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function bookmarkKey(scope: string): string {
  return `gitBookmarks.${scope}`;
}

function readBookmarks(scope: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(bookmarkKey(scope));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((sha) => typeof sha === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeBookmarks(scope: string, bookmarks: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(bookmarkKey(scope), JSON.stringify([...bookmarks]));
  } catch {}
}

function GitFilterButton({
  id, label, count, filter, setFilter,
}: {
  id: GitFilter;
  label: string;
  count: number;
  filter: GitFilter;
  setFilter: (filter: GitFilter) => void;
}) {
  const on = filter === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={`h-git-filter ${on ? 'on' : ''}`}
      onClick={() => setFilter(id)}
    >
      <span>{label}</span>
      <b>{count}</b>
    </button>
  );
}

function GitCommitRow({
  commit, laneCount, active, bookmarked, onSelect, onBookmark,
}: {
  commit: LaidOutCommit;
  laneCount: number;
  active: boolean;
  bookmarked: boolean;
  onSelect: (sha: string) => void;
  onBookmark: (sha: string) => void;
}) {
  const railWidth = Math.max(18, laneCount * 10);
  const dotLeft = commit.lane * 10 + 4;
  const color = laneColor(commit.lane);

  return (
    <div
      role="button"
      tabIndex={0}
      className={`h-git-row ${active ? 'is-active' : ''} ${bookmarked ? 'is-bookmarked' : ''}`}
      onClick={() => onSelect(commit.sha)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(commit.sha); }}
      title={`${commit.sha.slice(0, 12)} · ${commit.subject}`}
      aria-pressed={active}
    >
      <span className="h-git-rail" style={{ width: railWidth }}>
        {Array.from({ length: laneCount }).map((_, lane) => (
          <span
            key={lane}
            className={`h-git-lane${lane === commit.lane ? ' active' : ''}`}
            style={{ left: lane * 10 + 7, background: laneColor(lane) }}
          />
        ))}
        <span className="h-git-dot" style={{ left: dotLeft, background: color }} />
      </span>

      <span className="h-git-row-body">
        <span className="h-git-subject">{commit.subject}</span>
        <span className="h-git-meta">
          <span>{commit.sha.slice(0, 8)}</span>
          <span>{commit.author}</span>
          <time dateTime={new Date(commit.ts).toISOString()} title={formatTime(commit.ts)}>{formatAge(commit.ts)}</time>
          {commit.parents.length > 1 && <span className="h-git-merge">merge</span>}
        </span>
        {commit.refs.length > 0 && (
          <span className="h-git-refs" aria-label="Git references">
            {commit.refs.slice(0, 4).map((ref) => (
              <span key={ref} className={`h-git-ref ${refClass(ref)}`}>{refLabel(ref)}</span>
            ))}
            {commit.refs.length > 4 && <span className="h-git-ref muted">+{commit.refs.length - 4}</span>}
          </span>
        )}
      </span>
      <button
        type="button"
        className={`h-git-row-bookmark ${bookmarked ? 'on' : ''}`}
        aria-label={`${bookmarked ? 'Remove' : 'Add'} bookmarked commit ${commit.sha.slice(0, 8)}`}
        onClick={(e) => {
          e.stopPropagation();
          onBookmark(commit.sha);
        }}
      >
        ★
      </button>
    </div>
  );
}

export interface GitGraphPanelProps {
  /** Stable cache + bookmark key (e.g. `harness:sheets`, `restart-main`). */
  scope: string;
  /** Build the URL for fetching git log. Receives `limit` (count). */
  gitLogUrl: (limit: number) => string;
  /** Build the URL for fetching one commit's diff/patch detail. */
  showCommitUrl: (sha: string) => string;
  /** Optional builder for an external commit-view link (e.g. github.com/.../commit/SHA). */
  remoteCommitUrl?: (sha: string) => string;
  /** Optional: short title for the panel header (defaults to "git"). */
  title?: string;
  /** Optional: poll interval in ms; if set, refetch every N ms. */
  pollIntervalMs?: number;
}

export default function GitGraphPanel({
  scope,
  gitLogUrl,
  showCommitUrl,
  remoteCommitUrl,
  title,
  pollIntervalMs,
}: GitGraphPanelProps) {
  const [limit, setLimit] = useState<number>(300);
  const [commits, setCommits] = useState<Commit[] | null>(() => getCachedGitLog(scope, 300));
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<GitFilter>('all');
  const [bookmarked, setBookmarked] = useState<Set<string>>(() => readBookmarks(scope));
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let aborted = false;
    const cached = getCachedGitLog(scope, limit);
    setCommits(cached);
    setError(null);
    fetchGitLog(scope, limit, gitLogUrl(limit))
      .then((c) => { if (!aborted) setCommits(c); })
      .catch((e) => { if (!aborted) setError(String(e?.message ?? e)); });
    return () => { aborted = true; };
  }, [scope, limit, reloadTick, gitLogUrl]);

  useEffect(() => {
    setBookmarked(readBookmarks(scope));
  }, [scope]);

  useEffect(() => {
    writeBookmarks(scope, bookmarked);
  }, [scope, bookmarked]);

  // Optional polling for new commits.
  useEffect(() => {
    if (!pollIntervalMs || pollIntervalMs < 1000) return;
    const t = setInterval(() => setReloadTick((n) => n + 1), pollIntervalMs);
    return () => clearInterval(t);
  }, [pollIntervalMs]);

  useEffect(() => {
    if (!commits) return;
    setBookmarked((prev) => new Set([...prev].filter((sha) => commits.some((commit) => commit.sha === sha))));
  }, [commits]);

  const laidOut = useMemo(() => (commits ? assignLanes(commits) : []), [commits]);
  const laneCount = useMemo(() => Math.max(1, laidOut.reduce((max, commit) => Math.max(max, commit.lane + 1), 1)), [laidOut]);
  const latest = laidOut[0];
  const mergeCount = useMemo(() => laidOut.filter((commit) => commit.parents.length > 1).length, [laidOut]);
  const refCommits = useMemo(() => laidOut.filter((commit) => commit.refs.length > 0), [laidOut]);
  const uniqueRefs = useMemo(() => {
    const seen = new Set<string>();
    const refs: string[] = [];
    for (const commit of laidOut) {
      for (const ref of commit.refs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        refs.push(ref);
      }
    }
    return refs;
  }, [laidOut]);
  const topAuthors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const commit of laidOut) counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4);
  }, [laidOut]);

  const needle = query.trim().toLowerCase();
  const filteredCommits = useMemo(() => laidOut
    .filter((commit) => filter !== 'refs' || commit.refs.length > 0)
    .filter((commit) => filter !== 'merges' || commit.parents.length > 1)
    .filter((commit) => filter !== 'bookmarked' || bookmarked.has(commit.sha))
    .filter((commit) => matchesCommit(commit, needle)), [bookmarked, filter, laidOut, needle]);

  const onLimitChange = (nextLimit: number) => {
    setLimit(nextLimit);
    listRef.current?.scrollTo({ top: 0 });
  };

  const selectCommit = useCallback((sha: string) => {
    setSelectedSha(sha);
  }, []);

  const applyQuery = useCallback((next: string) => {
    setQuery(next);
    setFilter('all');
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  const resetFilters = useCallback(() => {
    setQuery('');
    setFilter('all');
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  const toggleBookmark = useCallback((sha: string) => {
    setBookmarked((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }, []);

  return (
    <>
      <div className="h-panel h-git-panel">
        <div className="h-panel-head h-git-head">
          <div className="h-git-title-stack">
            <span className="h-panel-title">git</span>
            <span className="h-panel-count">{filteredCommits.length}/{commits?.length ?? 0} visible</span>
          </div>
          <div className="h-panel-actions h-git-actions">
            <select
              className="h-git-limit"
              value={limit}
              onChange={(e) => onLimitChange(Number(e.target.value))}
              title="commit limit"
              aria-label="Git commit limit"
            >
              {LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button
              className="h-btn-icon"
              onClick={() => setReloadTick((t) => t + 1)}
              title="refresh git history"
              aria-label="Refresh git history"
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>

        <div className="h-git-command" aria-label="Git history controls">
          <div className="h-git-search-row">
            <input
              className="h-git-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SHA, author, ref…"
              aria-label="Search git history"
            />
            {(query || filter !== 'all') && (
              <button type="button" className="h-git-clear" onClick={resetFilters}>clear</button>
            )}
          </div>
          <div className="h-git-filter-row" role="tablist" aria-label="Git commit filter">
            <GitFilterButton id="all" label="All" count={laidOut.length} filter={filter} setFilter={setFilter} />
            <GitFilterButton id="refs" label="Refs" count={refCommits.length} filter={filter} setFilter={setFilter} />
            <GitFilterButton id="merges" label="Merges" count={mergeCount} filter={filter} setFilter={setFilter} />
            <GitFilterButton id="bookmarked" label="Stars" count={bookmarked.size} filter={filter} setFilter={setFilter} />
          </div>
        </div>

        <div className="h-git-summary" aria-label="Git history summary">
          <span><b>{filteredCommits.length}</b> shown</span>
          <span><b>{uniqueRefs.length}</b> ref{uniqueRefs.length === 1 ? '' : 's'}</span>
          <span><b>{latest ? formatAge(latest.ts) : '—'}</b> latest</span>
          <span><b>{bookmarked.size}</b> star{bookmarked.size === 1 ? '' : 's'}</span>
        </div>

        {uniqueRefs.length > 0 && (
          <div className="h-git-ref-rail" aria-label="Important refs">
            {uniqueRefs.slice(0, 8).map((ref) => (
              <button
                key={ref}
                type="button"
                className={`h-git-ref-chip ${refClass(ref)}`}
                onClick={() => applyQuery(ref)}
                title={`Filter by ${ref}`}
              >
                {refLabel(ref)}
              </button>
            ))}
          </div>
        )}

        {topAuthors.length > 1 && (
          <div className="h-git-author-rail" aria-label="Top commit authors">
            {topAuthors.map(([author, count]) => (
              <button key={author} type="button" onClick={() => applyQuery(author)} title={`Filter by ${author}`}>
                <span>{author}</span>
                <b>{count}</b>
              </button>
            ))}
          </div>
        )}

        {error && <div className="h-empty h-git-error">{error}</div>}
        {!commits && !error && <div className="h-empty">loading…</div>}
        {commits && commits.length === 0 && !error && <div className="h-empty">No commits found.</div>}
        {commits && commits.length > 0 && filteredCommits.length === 0 && !error && (
          <div className="h-empty h-git-empty">
            <span>No commits match this view.</span>
            <button type="button" className="h-git-clear" onClick={resetFilters}>clear filters</button>
          </div>
        )}

        {filteredCommits.length > 0 && (
          <div
            ref={listRef}
            className="h-git-list"
            onWheel={(e) => e.stopPropagation()}
          >
            {filteredCommits.map((commit) => (
              <GitCommitRow
                key={commit.sha}
                commit={commit}
                laneCount={laneCount}
                active={selectedSha === commit.sha}
                onSelect={selectCommit}
                bookmarked={bookmarked.has(commit.sha)}
                onBookmark={toggleBookmark}
              />
            ))}
          </div>
        )}
      </div>

      {selectedSha && (
        <CommitDetail
          sha={selectedSha}
          showCommitUrl={showCommitUrl}
          remoteCommitUrl={remoteCommitUrl}
          onClose={() => setSelectedSha(null)}
        />
      )}
    </>
  );
}
