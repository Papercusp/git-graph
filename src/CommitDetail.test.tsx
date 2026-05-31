// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CommitDetail } from './CommitDetail';

// Stub the heavy diff renderer — these tests exercise CommitDetail's
// fetch/parse/empty-state state machine, not react-diff-view's output.
vi.mock('react-diff-view', async () => {
  const actual = await vi.importActual<typeof import('react-diff-view')>('react-diff-view');
  return {
    ...actual,
    Diff: ({
      hunks,
      children,
    }: {
      hunks: unknown[];
      children?: (hunks: unknown[]) => ReactNode;
    }) => <div data-testid="diff-viewer">{children?.(hunks)}</div>,
    Hunk: ({ hunk }: { hunk: { content: string } }) => (
      <div data-testid="diff-hunk">{hunk.content}</div>
    ),
  };
});

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

function filePatch(path: string, body = 'const b = 3;'): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    'index 1111111..2222222 100644\n' +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    '@@ -1,2 +1,2 @@\n' +
    ' const a = 1;\n' +
    '-const b = 2;\n' +
    `+${body}\n`
  );
}

const MULTI_FILE_PATCH = [
  filePatch('one.ts'),
  filePatch('two.ts'),
  filePatch('three.ts'),
  // Larger than the old auto-expand threshold, but still below the raw fallback
  // limit. This catches regressions where later/large files start collapsed and
  // require a click before their already-parsed diff is visible.
  filePatch('four.ts', `const b = "${'x'.repeat(9_000)}";`),
].join('\n');

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function mockFetchUrl(fetchMock: unknown, callIndex: number): string {
  const calls = (fetchMock as { mock: { calls: unknown[][] } }).mock.calls;
  return String(calls[callIndex]?.[0] ?? '');
}

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const showUrl = (s: string) => `/api/harness/sheets/git/show/${s}`;

describe('CommitDetail — empty patch', () => {
  it('resolves to the empty-state instead of hanging when even the automatic full diff is empty', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ...BASE, patch: '' }));
    global.fetch = fetchMock as typeof fetch;

    render(<CommitDetail sha={BASE.sha} showCommitUrl={showUrl} onClose={() => {}} />);

    expect(await screen.findByText(/Empty commit/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockFetchUrl(fetchMock, 1)).toContain('full=1');
    expect(screen.queryByText(/parsing diff/i)).toBeNull();
    expect(screen.queryByText(/loading diff/i)).toBeNull();
  });

  it('automatically refetches with ?full=1 and renders the recovered patch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...BASE, patch: '' }))
      .mockResolvedValueOnce(jsonResponse({ ...BASE, patch: REAL_PATCH }));
    global.fetch = fetchMock as typeof fetch;

    render(<CommitDetail sha={BASE.sha} showCommitUrl={showUrl} onClose={() => {}} />);

    expect(await screen.findByText('foo.ts')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show full diff/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockFetchUrl(fetchMock, 1)).toContain('full=1');
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

  it('renders every parsed file open by default, including later large files', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ ...BASE, patch: MULTI_FILE_PATCH })) as typeof fetch;

    render(<CommitDetail sha={BASE.sha} showCommitUrl={showUrl} onClose={() => {}} />);

    expect(await screen.findByText('four.ts')).toBeTruthy();
    expect(screen.getAllByTestId('diff-viewer')).toHaveLength(4);
  });
});
