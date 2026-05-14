'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Folder, Copy, Check } from 'lucide-react';

export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
  isMain: boolean;
  lastCommitTs: number | null;
}

interface WorktreesResponse {
  worktrees?: Worktree[];
  notAGitRepo?: boolean;
  error?: string;
}

function formatRelativeTs(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return new Date(ms).toLocaleString();
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {/* fall through to execCommand */}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

export function WorktreeList({
  worktreesUrl,
  showCommitUrl,
  onPickCommit,
  pollIntervalMs = 30_000,
}: {
  worktreesUrl: () => string;
  /** Optional — when omitted, HEAD sha renders as plain text. */
  showCommitUrl?: (sha: string) => string;
  /** Optional — callback to open CommitDetail in the parent panel for a sha. */
  onPickCommit?: (sha: string) => void;
  pollIntervalMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<WorktreesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const url = worktreesUrl();

  useEffect(() => {
    let aborted = false;
    const load = () => {
      fetch(url)
        .then((r) => r.json())
        .then((d: WorktreesResponse) => {
          if (aborted) return;
          if (d.error) setError(d.error);
          else { setData(d); setError(null); }
        })
        .catch((e) => { if (!aborted) setError(String(e?.message ?? e)); });
    };
    load();
    const t = pollIntervalMs > 0 ? setInterval(load, pollIntervalMs) : null;
    return () => { aborted = true; if (t) clearInterval(t); };
  }, [url, pollIntervalMs]);

  const worktrees = data?.worktrees ?? null;
  const count = worktrees?.length ?? 0;

  const onCopyPath = async (p: string) => {
    if (await copy(p)) {
      setCopiedPath(p);
      window.setTimeout(() => setCopiedPath((cur) => (cur === p ? null : cur)), 1100);
    }
  };

  return (
    <section className="h-git-worktree-section" aria-label="Worktrees">
      <button
        type="button"
        className="h-git-worktree-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Worktrees</span>
        <span className="h-git-worktree-count">{count}</span>
        {!worktrees && !error && <Loader2 size={11} className="h-git-worktree-spin" />}
      </button>

      {open && (
        <div className="h-git-worktree-body">
          {error && <div className="h-empty h-git-error">{error}</div>}
          {!error && data?.notAGitRepo && (
            <div className="h-git-worktree-empty">Not a git repository.</div>
          )}
          {!error && worktrees && worktrees.length === 0 && !data?.notAGitRepo && (
            <div className="h-git-worktree-empty">No worktrees.</div>
          )}
          {!error && worktrees && worktrees.length > 0 && (
            <ul className="h-git-worktree-list">
              {worktrees.map((wt) => {
                const shortSha = wt.head ? wt.head.slice(0, 8) : '';
                const branchLabel = wt.bare
                  ? '(bare)'
                  : wt.detached
                    ? `(detached @ ${shortSha})`
                    : wt.branch ?? '(no branch)';
                const canClickSha = !!showCommitUrl && !!onPickCommit && !!wt.head;
                return (
                  <li key={wt.path} className="h-git-worktree-row">
                    <div className="h-git-worktree-pathline">
                      <Folder size={11} className="h-git-worktree-icon" />
                      <button
                        type="button"
                        className="h-git-worktree-path"
                        onClick={() => onCopyPath(wt.path)}
                        title="Click to copy"
                      >
                        {wt.path}
                      </button>
                      {copiedPath === wt.path ? (
                        <Check size={11} className="h-git-worktree-copied" />
                      ) : (
                        <Copy size={10} className="h-git-worktree-copyhint" />
                      )}
                      <div className="h-git-worktree-badges">
                        {wt.isMain && <span className="h-git-worktree-badge h-git-worktree-badge--main">main</span>}
                        {wt.bare && <span className="h-git-worktree-badge">bare</span>}
                        {wt.detached && <span className="h-git-worktree-badge h-git-worktree-badge--warn">detached</span>}
                        {wt.locked && (
                          <span className="h-git-worktree-badge h-git-worktree-badge--warn" title={wt.lockedReason ?? 'locked'}>
                            locked
                          </span>
                        )}
                        {wt.prunable && (
                          <span className="h-git-worktree-badge h-git-worktree-badge--bad" title={wt.prunableReason ?? 'prunable'}>
                            prunable
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="h-git-worktree-meta">
                      <span className="h-git-worktree-branch">{branchLabel}</span>
                      {!wt.detached && !wt.bare && wt.head && (
                        canClickSha ? (
                          <button
                            type="button"
                            className="h-git-worktree-sha"
                            onClick={() => onPickCommit!(wt.head)}
                            title="Open commit"
                          >
                            {shortSha}
                          </button>
                        ) : (
                          <code className="h-git-worktree-sha">{shortSha}</code>
                        )
                      )}
                      {wt.lastCommitTs && (
                        <span className="h-git-worktree-ts">{formatRelativeTs(wt.lastCommitTs)}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
