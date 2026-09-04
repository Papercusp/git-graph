// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommitDetail } from './CommitDetail';

// Stub the heavy diff renderer — these tests exercise CommitDetail's
// fetch/parse/empty-state state machine, not react-diff-view's output.
vi.mock('react-diff-view', () => ({
  Diff: ({ children }: { children: (hunks: unknown[]) => unknown }) => (
    <div data-testid="diff-viewer">{children([])}</div>
  ),
  Hunk: () => null,
  parseDiff: (patch: string) => {
    const lines = patch.split('\n');
    const paths = lines.filter((l) => l.startsWith('diff --git')).map((l) => {
      const m = l.match(/^diff --git a\/(.+) b\/(.+)$/);
      return m?.[2] ?? m?.[1] ?? 'unknown';
    });
    return paths.map((path) => ({
      type: 'modify',
      oldPath: path,
      newPath: path,
      hunks: [{ oldStart: 1, newStart: 1, content: '' }], // At least one hunk to trigger DiffFileViewer
    }));
  },
}));

// GitTooltip wraps Radix Tooltip, which needs a TooltipProvider ancestor.
// These tests render CommitDetail bare; the tooltip is irrelevant to the
// fetch/parse/empty-state logic under test, so stub it to a passthrough.
vi.mock('./GitTooltip', () => ({
  GitTooltip: ({ children }: { children: unknown }) => children,
}));

const BASE = {
  sha: 'c39d799c41aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  author: 'Avi',
  email: 'avi@storewolf.com',
  ts: 1778800000000,
  parents: ['08844b6b7683c1e65539a497fe7ea7eebe945820'],
  subject: 'chunk: harness-only changes',
  body: '',
  patchTruncated: false,
  patchTotalBytes: 0,
};

const REAL_PATCH =
  'diff --git a/foo.ts b/foo.ts\n' +
  'index 1111111..2222222 100644\n' +
  '--- a/foo.ts\n' +
  '+++ b/foo.ts\n' +
  '@@ -1,2 +1,2 @@\n' +
  ' const a = 1;\n' +
  '-const b = 2;\n' +
  '+const b = 3;\n';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const showUrl = (s: string) => `/api/harness/sheets/git/show/${s}`;

describe('CommitDetail — empty patch', () => {
  it('resolves to the empty-state instead of hanging on the loading frame', async () => {
    // Regression: a commit whose every changed path is filtered by the
    // server's default excludes (.harness/**, lockfiles, snapshots) returns
    // patch: ''. The parse effect used to bail before setFiles ran, leaving
    // the modal stuck on "parsing diff…" forever.
    global.fetch = vi.fn(async () => jsonResponse({ ...BASE, patch: '' })) as typeof fetch;

    render(<CommitDetail sha={BASE.sha} showCommitUrl={showUrl} onClose={() => {}} />);

    expect(await screen.findByText(/Empty commit/i)).toBeTruthy();
    expect(screen.queryByText(/parsing diff/i)).toBeNull();
    expect(screen.queryByText(/loading diff/i)).toBeNull();
  });

  it('automatically refetches with ?full=1 when initial patch is empty', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...BASE, patch: '' }))
      .mockResolvedValueOnce(jsonResponse({ ...BASE, patch: REAL_PATCH }));
    global.fetch = fetchMock as typeof fetch;

    render(<CommitDetail sha={BASE.sha} showCommitUrl={showUrl} onClose={() => {}} />);

    expect(await screen.findByText('foo.ts')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('full=1');
  });

  it('labels a merge commit instead of offering a full-diff refetch', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ ...BASE, patch: '', parents: ['aaa1111', 'bbb2222'] }),
    ) as typeof fetch;

    render(<CommitDetail sha={BASE.sha} showCommitUrl={showUrl} onClose={() => {}} />);

    expect(await screen.findByText(/Merge commit/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show full diff/i })).toBeNull();
  });
});

describe('CommitDetail — normal patch', () => {
  it('parses and renders a file diff', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ ...BASE, patch: REAL_PATCH })) as typeof fetch;

    render(<CommitDetail sha={BASE.sha} showCommitUrl={showUrl} onClose={() => {}} />);

    expect(await screen.findByText('foo.ts')).toBeTruthy();
    expect(screen.getByTestId('diff-viewer')).toBeTruthy();
  });
});
