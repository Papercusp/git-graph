'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

interface CommitMeta {
  sha: string;
  author: string;
  email: string;
  ts: number;
  parents: string[];
  subject: string;
  body: string;
  patch: string;
  patchTruncated?: boolean;
}

interface HunkFile {
  header: string;
  path: string;
  before: string;
  after: string;
}

// Minimal unified-diff → { path, old, new } splitter. Handles plain file headers;
// does not attempt to perfectly reconstruct the original files (that would need
// `git show <sha>:<path>` per file) — but it's enough for visual review.
function splitDiff(patch: string): HunkFile[] {
  const files: HunkFile[] = [];
  const lines = patch.split('\n');
  let current: HunkFile | null = null;

  const push = () => { if (current) files.push(current); };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      push();
      const pathMatch = line.match(/ b\/(.+)$/);
      current = {
        header: line,
        path: pathMatch?.[1] ?? '(file)',
        before: '',
        after: '',
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('rename ') || line.startsWith('similarity index')) {
      continue;
    }
    if (line.startsWith('@@')) {
      // hunk header — visible in diff viewer's own UI; we skip here but add blank line separators.
      if (current.before) current.before += '\n';
      if (current.after) current.after += '\n';
      continue;
    }
    if (line.startsWith('-')) {
      current.before += (current.before ? '\n' : '') + line.slice(1);
    } else if (line.startsWith('+')) {
      current.after += (current.after ? '\n' : '') + line.slice(1);
    } else if (line.startsWith(' ')) {
      // context line — appears in both.
      const body = line.slice(1);
      current.before += (current.before ? '\n' : '') + body;
      current.after += (current.after ? '\n' : '') + body;
    }
  }
  push();
  return files;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function CommitDetail({
  sha,
  showCommitUrl,
  remoteCommitUrl,
  onClose,
}: {
  sha: string;
  /** Function building the API URL for the commit detail (returns full diff/patch). */
  showCommitUrl: (sha: string) => string;
  /** Optional builder for an external view URL (e.g. github.com/owner/repo/commit/SHA). */
  remoteCommitUrl?: (sha: string) => string;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<CommitMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Keep the URL builder in a ref so this effect only re-runs when the
  // SHA changes. Callers pass an inline arrow each render (stable behavior,
  // unstable identity), and depending on it caused an infinite fetch loop.
  const showCommitUrlRef = useRef(showCommitUrl);
  showCommitUrlRef.current = showCommitUrl;

  useEffect(() => {
    let aborted = false;
    const ctrl = new AbortController();
    setMeta(null);
    setError(null);
    setCopied(false);
    fetch(showCommitUrlRef.current(sha), { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (aborted) return;
        if (d.error) setError(d.error);
        else setMeta(d);
      })
      .catch((e) => { if (!aborted && e?.name !== 'AbortError') setError(String(e)); });
    return () => { aborted = true; ctrl.abort(); };
  }, [sha]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const files = meta?.patch ? splitDiff(meta.patch) : [];
  const displaySha = meta?.sha ?? sha;

  const copySha = async () => {
    try {
      let copiedSha = false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(displaySha);
          copiedSha = true;
        } catch {
          copiedSha = false;
        }
      }
      if (!copiedSha) {
        const textarea = document.createElement('textarea');
        textarea.value = displaySha;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="h-git-detail-overlay"
      onClick={onClose}
    >
      <section
        className="h-git-detail-drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label="Commit diff"
      >
        <header className="h-git-detail-head">
          <div className="h-git-detail-id">
            <span>commit</span>
            <code>{displaySha.slice(0, 12)}</code>
          </div>

          <div className="h-git-detail-title-stack">
            <strong>{meta?.subject ?? 'Loading commit…'}</strong>
            <div className="h-git-detail-meta">
              <span>{meta?.author ?? 'resolving author'}</span>
              <span>{meta ? formatTs(meta.ts) : 'loading timestamp'}</span>
              <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
              {meta?.parents.length ? <span>{meta.parents.length} parent{meta.parents.length === 1 ? '' : 's'}</span> : null}
            </div>
          </div>

          <div className="h-git-detail-actions">
            <button type="button" className="h-git-detail-copy" onClick={copySha}>
              {copied ? 'copied' : 'copy sha'}
            </button>
            <button className="h-btn-icon" onClick={onClose} title="Close (esc)" aria-label="Close commit detail">
              <X size={14} />
            </button>
          </div>
        </header>

        {!meta && !error && (
          <div className="h-empty h-git-detail-loading">
            <Loader2 size={16} className="h-empty-icon" />
            <span>loading diff…</span>
          </div>
        )}
        {error && <div className="h-empty h-git-error">{error}</div>}

        {meta && (
          <div className="h-git-detail-body">
            {meta.body && (
              <pre className="h-git-detail-message">{meta.body}</pre>
            )}
            {meta.patchTruncated && (
              <div className="h-git-detail-truncated" role="status">
                This commit's diff is too large to render in full. Showing the first ~8&nbsp;MB; later files may be missing.
                {remoteCommitUrl && (
                  <>
                    {' '}
                    <a href={remoteCommitUrl(displaySha)} target="_blank" rel="noreferrer">Open full commit ↗</a>
                  </>
                )}
              </div>
            )}
            {files.length === 0 && !error && (
              <div className="h-git-detail-empty">(no diff — merge or empty commit)</div>
            )}
            {files.map((f) => (
              <div key={f.path} className="h-git-file-card">
                <div className="h-git-file-head">
                  <span>{f.path}</span>
                </div>
                <ReactDiffViewer
                  oldValue={f.before}
                  newValue={f.after}
                  splitView={false}
                  useDarkTheme
                  compareMethod={DiffMethod.LINES}
                  styles={{
                    variables: {
                      dark: {
                        diffViewerBackground: 'var(--bg-2)',
                        diffViewerColor: 'var(--fg)',
                        addedBackground: 'color-mix(in oklab, var(--good), transparent 85%)',
                        addedColor: 'var(--fg)',
                        removedBackground: 'color-mix(in oklab, var(--bad), transparent 85%)',
                        removedColor: 'var(--fg)',
                        wordAddedBackground: 'color-mix(in oklab, var(--good), transparent 60%)',
                        wordRemovedBackground: 'color-mix(in oklab, var(--bad), transparent 60%)',
                        codeFoldBackground: 'var(--bg-3)',
                        gutterBackground: 'var(--bg)',
                        gutterColor: 'var(--fg-dim)',
                        addedGutterBackground: 'color-mix(in oklab, var(--good), transparent 85%)',
                        removedGutterBackground: 'color-mix(in oklab, var(--bad), transparent 85%)',
                        emptyLineBackground: 'var(--bg-2)',
                        diffViewerTitleColor: 'var(--fg)',
                      },
                    },
                    contentText: { fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace', fontSize: 11.5, lineHeight: '1.45' },
                    line: { padding: '0 8px' },
                    gutter: { padding: '0 6px', minWidth: 28 },
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
