'use client';

import { useEffect, useMemo, useState } from 'react';
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
  patchTotalBytes?: number;
}

interface HunkFile {
  header: string;
  path: string;
  before: string;
  after: string;
  /** True if this file's diff is too large to render through ReactDiffViewer. */
  oversize: boolean;
  /** Raw per-file patch slice — shown as <pre> when oversize. */
  rawPatch: string;
}

// Per-file size cap above which we skip ReactDiffViewer and render a <pre> block.
// ReactDiffViewer constructs a row per line and diffs them; for huge generated files
// (e.g. .harness/issues.json with 1700+ changed lines) it blocks the main thread.
const PER_FILE_DIFF_LIMIT = 96 * 1024; // 96 KB of before/after content per file

// Hard ceiling on the number of files we'll attempt to render at all.
const MAX_FILES_RENDERED = 200;

/**
 * O(n) unified-diff splitter. Pushes lines into per-file arrays and joins once
 * at the end — the previous version used `+=` string concatenation, which is
 * O(n²) and would lock the render thread on multi-MB patches.
 */
function splitDiff(patch: string): HunkFile[] {
  const files: HunkFile[] = [];
  const lines = patch.split('\n');

  let currentPath = '(file)';
  let currentHeader = '';
  let before: string[] = [];
  let after: string[] = [];
  let raw: string[] = [];
  let started = false;

  const flush = () => {
    if (!started) return;
    const beforeStr = before.join('\n');
    const afterStr = after.join('\n');
    const rawPatch = raw.join('\n');
    const oversize =
      beforeStr.length > PER_FILE_DIFF_LIMIT ||
      afterStr.length > PER_FILE_DIFF_LIMIT;
    files.push({
      header: currentHeader,
      path: currentPath,
      before: beforeStr,
      after: afterStr,
      oversize,
      rawPatch,
    });
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const pathMatch = line.match(/ b\/(.+)$/);
      currentHeader = line;
      currentPath = pathMatch?.[1] ?? '(file)';
      before = [];
      after = [];
      raw = [line];
      started = true;
      continue;
    }
    if (!started) continue;
    raw.push(line);

    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('rename ') || line.startsWith('similarity index')) {
      continue;
    }
    if (line.startsWith('@@')) {
      if (before.length) before.push('');
      if (after.length) after.push('');
      continue;
    }
    if (line.startsWith('-')) {
      before.push(line.slice(1));
    } else if (line.startsWith('+')) {
      after.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const body = line.slice(1);
      before.push(body);
      after.push(body);
    }
  }
  flush();
  return files;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  /** Async-split state: gated so we can show "parsing diff…" while it's pending. */
  const [files, setFiles] = useState<HunkFile[] | null>(null);

  useEffect(() => {
    let aborted = false;
    setMeta(null);
    setError(null);
    setFiles(null);
    setCopied(false);
    fetch(showCommitUrl(sha))
      .then((r) => r.json())
      .then((d) => {
        if (aborted) return;
        if (d.error) setError(d.error);
        else setMeta(d);
      })
      .catch((e) => { if (!aborted) setError(String(e)); });
    return () => { aborted = true; };
  }, [sha, showCommitUrl]);

  // Parse the patch off the synchronous render path. For multi-MB patches
  // splitDiff can still take 200-800 ms; pushing it into a microtask lets
  // the "parsing diff…" frame paint instead of leaving the user stuck on
  // "loading diff…" while the main thread is busy.
  useEffect(() => {
    if (!meta?.patch) return;
    let aborted = false;
    setFiles(null);
    const id = setTimeout(() => {
      if (aborted) return;
      try {
        const parsed = splitDiff(meta.patch);
        if (!aborted) setFiles(parsed);
      } catch (e) {
        if (!aborted) setError(`diff parse failed: ${String(e)}`);
      }
    }, 0);
    return () => { aborted = true; clearTimeout(id); };
  }, [meta?.patch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filesToShow = useMemo(() => {
    if (!files) return [] as HunkFile[];
    return files.slice(0, MAX_FILES_RENDERED);
  }, [files]);

  const fileCount = files?.length ?? 0;
  const hiddenCount = Math.max(0, fileCount - MAX_FILES_RENDERED);
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
              <span>{fileCount} file{fileCount === 1 ? '' : 's'}</span>
              {meta?.parents.length ? <span>{meta.parents.length} parent{meta.parents.length === 1 ? '' : 's'}</span> : null}
              {meta?.patchTruncated ? <span style={{ color: 'var(--bad)' }}>patch truncated</span> : null}
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
        {meta && !files && !error && (
          <div className="h-empty h-git-detail-loading">
            <Loader2 size={16} className="h-empty-icon" />
            <span>parsing diff…</span>
          </div>
        )}
        {error && <div className="h-empty h-git-error">{error}</div>}

        {meta && files && (
          <div className="h-git-detail-body">
            {meta.body && (
              <pre className="h-git-detail-message">{meta.body}</pre>
            )}
            {files.length === 0 && !error && (
              <div className="h-git-detail-empty">(no diff — merge or empty commit)</div>
            )}
            {filesToShow.map((f, idx) => (
              <div key={`${f.path}:${idx}`} className="h-git-file-card">
                <div className="h-git-file-head">
                  <span>{f.path}</span>
                  {f.oversize && (
                    <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--fg-dim)' }}>
                      large file — showing raw patch ({formatBytes(f.rawPatch.length)})
                    </span>
                  )}
                </div>
                {f.oversize ? (
                  <pre
                    style={{
                      margin: 0,
                      padding: '8px 10px',
                      fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace',
                      fontSize: 11.5,
                      lineHeight: 1.45,
                      maxHeight: 480,
                      overflow: 'auto',
                      background: 'var(--bg-2)',
                      color: 'var(--fg)',
                      whiteSpace: 'pre',
                    }}
                  >
                    {f.rawPatch}
                  </pre>
                ) : (
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
                )}
              </div>
            ))}
            {hiddenCount > 0 && (
              <div className="h-git-detail-empty">
                … {hiddenCount} more file{hiddenCount === 1 ? '' : 's'} not rendered (showing first {MAX_FILES_RENDERED}).
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
