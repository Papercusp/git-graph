import { describe, it, expect } from 'vitest';
import {
  assignLanes,
  buildGraph,
  laneColor,
  LANE_COLORS,
  LANE_WIDTH,
  ROW_HEIGHT,
  type Commit,
} from './graphLayout';

/**
 * graphLayout.test.ts — P-016 of test-coverage-rest-non-critical. Pure gitk-style
 * commit-graph layout: lane assignment, palette color, and the node/edge build.
 */

const c = (sha: string, parents: string[] = []): Commit => ({
  sha,
  parents,
  subject: sha,
  author: 'a',
  ts: 0,
  refs: [],
});

describe('assignLanes', () => {
  it('keeps a linear history in a single lane, one row per commit', () => {
    const out = assignLanes([c('A', ['B']), c('B', ['C']), c('C')]);
    expect(out.map((x) => [x.sha, x.lane, x.row])).toEqual([
      ['A', 0, 0],
      ['B', 0, 1],
      ['C', 0, 2],
    ]);
  });

  it('spawns a second lane for a merge and collapses it when the shared parent lands', () => {
    // newest-first: a merge M of A+B, both branching from C.
    const out = assignLanes([c('M', ['A', 'B']), c('A', ['C']), c('B', ['C']), c('C')]);
    const lane = (sha: string) => out.find((x) => x.sha === sha)!.lane;
    expect(lane('M')).toBe(0);
    expect(lane('A')).toBe(0); // first parent stays in the merge's lane
    expect(lane('B')).toBe(1); // second parent claims a fresh lane
    expect(lane('C')).toBe(0); // both lanes waited on C → collapse into lane 0
    expect(out.map((x) => x.row)).toEqual([0, 1, 2, 3]);
  });

  it('handles an octopus merge: 3+ parents fan out to fresh lanes, then collapse into one', () => {
    // Gap 8 — M is an octopus merge of A, B, C, all branching from Z.
    // First parent A stays in M's lane (0); B and C each claim a fresh lane (1, 2);
    // when Z lands, all three pending lanes that waited on Z collapse into lane 0,
    // and Z appears exactly once.
    const out = assignLanes([
      c('M', ['A', 'B', 'C']),
      c('A', ['Z']),
      c('B', ['Z']),
      c('C', ['Z']),
      c('Z'),
    ]);
    const lane = (sha: string) => out.find((x) => x.sha === sha)!.lane;
    expect(lane('M')).toBe(0);
    expect(lane('A')).toBe(0); // first parent rides M's lane
    expect(lane('B')).toBe(1); // second parent → fresh lane
    expect(lane('C')).toBe(2); // third parent → fresh lane
    expect(lane('Z')).toBe(0); // all three pending lanes collapse into the lowest
    // Z appears exactly once even though three lanes waited on it.
    expect(out.filter((x) => x.sha === 'Z')).toHaveLength(1);
    expect(out.map((x) => x.row)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reclaims a freed lane for a later independent branch instead of pushing higher', () => {
    // Gap 10 — firstFree() reuse. Newest-first sequence:
    //   M1 merges H + B1 (B1 opens lane 1); collapse at C frees lane 1;
    //   M2 merges A + B2 (B2 must REUSE the now-free lane 1, not grab lane 2).
    const out = assignLanes([
      c('M1', ['H', 'B1']), // row 0 — opens lane 1 for B1
      c('B1', ['C']), // row 1 — lane 1, waits on C
      c('H', ['C']), // row 2 — lane 0, waits on C
      c('C', ['M2']), // row 3 — C collapses lanes 0 & 1 into 0, frees lane 1
      c('M2', ['A', 'B2']), // row 4 — lane 0; B2 needs a fresh lane
      c('B2', ['A']), // row 5 — should reuse freed lane 1
      c('A'), // row 6
    ]);
    const lane = (sha: string) => out.find((x) => x.sha === sha)!.lane;
    expect(lane('B1')).toBe(1); // first branch opened lane 1
    expect(lane('C')).toBe(0); // collapse frees lane 1
    expect(lane('B2')).toBe(1); // second independent branch REUSES lane 1 (not 2)
    // No lane should have climbed to 2 — reuse, not growth.
    expect(Math.max(...out.map((x) => x.lane))).toBe(1);
  });
});

describe('laneColor', () => {
  it('maps a lane to its palette color and wraps past the palette length', () => {
    expect(laneColor(0)).toBe(LANE_COLORS[0]);
    expect(laneColor(3)).toBe(LANE_COLORS[3]);
    expect(laneColor(LANE_COLORS.length)).toBe(LANE_COLORS[0]); // wraps
    expect(laneColor(LANE_COLORS.length + 2)).toBe(LANE_COLORS[2]);
  });

  it('returns undefined for a negative lane (current behavior — see FLAG below)', () => {
    // Gap 9 — guard gap on the exported primitive. JS negative modulo:
    // -1 % 10 === -1, so LANE_COLORS[-1] is undefined. This is the CURRENT
    // behavior, pinned. It is NOT reachable from any real caller: assignLanes
    // only ever produces lanes >= 0 (firstFree returns an index >= 0) and every
    // UI consumer iterates 0..laneCount, so negative input is not a live misuse
    // path. The contract here is non-negative-lane-only; this test pins that a
    // misuse returns undefined rather than throwing. If laneColor ever needs to
    // tolerate negative input, the wrap-safe fix is ((lane % n) + n) % n.
    expect(laneColor(-1)).toBeUndefined();
    expect(laneColor(-LANE_COLORS.length)).toBe(LANE_COLORS[0]); // exact multiple wraps to 0
  });
});

describe('buildGraph', () => {
  it('positions nodes by lane/row and emits child→parent edges for in-set parents', () => {
    const { nodes, edges } = buildGraph([c('A', ['B']), c('B', ['C']), c('C')]);
    expect(nodes).toHaveLength(3);
    const a = nodes.find((n) => n.id === 'A')!;
    expect(a.position).toEqual({ x: 0 * LANE_WIDTH, y: 0 * ROW_HEIGHT });
    const b = nodes.find((n) => n.id === 'B')!;
    expect(b.position).toEqual({ x: 0 * LANE_WIDTH, y: 1 * ROW_HEIGHT });
    expect(edges.map((e) => e.id).sort()).toEqual(['A->B', 'B->C']);
    expect(nodes.every((n) => n.data.maxLane === 0)).toBe(true);
  });

  it('skips edges to parents that are not in the commit set', () => {
    const { nodes, edges } = buildGraph([c('X', ['missing'])]);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });
});
