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
});

describe('laneColor', () => {
  it('maps a lane to its palette color and wraps past the palette length', () => {
    expect(laneColor(0)).toBe(LANE_COLORS[0]);
    expect(laneColor(3)).toBe(LANE_COLORS[3]);
    expect(laneColor(LANE_COLORS.length)).toBe(LANE_COLORS[0]); // wraps
    expect(laneColor(LANE_COLORS.length + 2)).toBe(LANE_COLORS[2]);
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
