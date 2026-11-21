// sokoban-solver-01-run-20261121
//
// A push-optimal Sokoban solver.
//
// Idea: a generated level is a hallway with one to four rooms off it, and a box
// pushed out of a room through its door can never come back, so the rooms are
// independent problems. The solver therefore splits each level into its rooms
// and answers every room with a breadth-first search over pushes, which meets
// the solved state in the fewest pushes possible. Two deadlocks prune the
// search without ever cutting a solvable state: a box on a square from which
// no push can ever reach a goal, and a frozen 2x2 block of walls and boxes
// holding a box off its goal.
//
// Everything here is deterministic: fixed direction order, sorted box lists,
// a FIFO queue, and work budgets counted in states, never in wall-clock time.
// No clock is read and nothing random is used, so two runs on the same input
// write byte-identical output.
//
// Local run:
//   MAKEFUN_INPUT_DIR=../kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Directions and budgets
// ---------------------------------------------------------------------------

// Direction order is fixed everywhere: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const WALK = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

// States one room search may keep before it gives up (work, never the clock).
const ROOM_STATE_CAP = 250_000;
// States a retried room search may keep.
const ROOM_RETRY_CAP = 1_000_000;
// States all push searches of one run may keep together.
const RUN_STATE_BUDGET = 2_500_000;
// Expansions the move-based fallback search may make per instance.
const FALLBACK_EXPANSION_CAP = 200_000;

// Work spent so far in this run, across every push search.
let statesSpent = 0;

// ---------------------------------------------------------------------------
// Level parsing (XSB)
// ---------------------------------------------------------------------------

type Level = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall, 0 = floor
  goals: number[]; // sorted square indices
  boxes: number[]; // sorted square indices
  player: number; // square index
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever the text shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// ---------------------------------------------------------------------------
// Dead squares: reverse pull-reachability from the goals
// ---------------------------------------------------------------------------

// live[i] = 1 when a box alone on square i can be pushed onto some goal.
// Computed by pulling backwards from the goals: a box can be pulled from
// square y to square x (one step back) when both squares are open floor.
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d;
      if (wall[y] === 0 && wall[y - d] === 0 && live[y] === 0) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// ---------------------------------------------------------------------------
// Reachability: the player's region, named by its lowest square
// ---------------------------------------------------------------------------

// Flood-fills the player's region from `from` over floor squares that hold no
// box, marking it in `seen` with `stamp`. Returns the region's lowest square
// index; the region itself is the set of squares stamped with `stamp`.
function floodRegion(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// ---------------------------------------------------------------------------
// Frozen 2x2 blocks
// ---------------------------------------------------------------------------

// True when the box just pushed onto `t` sits in a 2x2 block of walls and
// boxes that holds a box off its goal: such a block can never move again.
function isFrozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  // The four 2x2 blocks that contain t, named by their top-left corner.
  const corners = [t, t - 1, t - w, t - w - 1];
  for (const a of corners) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    const solid =
      (wall[a] === 1 || occupied[a] === 1) &&
      (wall[b] === 1 || occupied[b] === 1) &&
      (wall[c] === 1 || occupied[c] === 1) &&
      (wall[d] === 1 || occupied[d] === 1);
    if (!solid) continue;
    const stuckOffGoal =
      (occupied[a] === 1 && goal[a] === 0) ||
      (occupied[b] === 1 && goal[b] === 0) ||
      (occupied[c] === 1 && goal[c] === 0) ||
      (occupied[d] === 1 && goal[d] === 0);
    if (stuckOffGoal) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Push-optimal breadth-first search over one level (or one room)
// ---------------------------------------------------------------------------

type SearchResult = { pushes: number; moves: string };

// A state's identity: its region's lowest square plus its sorted box squares.
// String keys stay exact for any box count, unlike a base-size number.
function stateKey(boxes: number[], low: number): string {
  return low + '|' + boxes.join(',');
}

// The shortest walk from `from` to `to` around walls and boxes, in lower-case
// letters. Ties break by direction order (up first), so the walk is unique.
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string | null {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] === 1 || occupied[q] === 1 || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = WALK[k];
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

// The square the player stands on after playing `moves` from `from`.
function endSquare(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

// Push-optimal solution of `level` within `maxStates` states, or null when the
// search gives up (cap hit) or the level cannot be solved. States expand in
// FIFO order of pushes made, so the first solved state met is optimal.
function solveByPushes(level: Level, maxStates: number): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size); // region stamps, one per expansion
  const mark = new Int32Array(size); // region stamps, one per candidate push
  const stack = new Int32Array(size);
  let stamp = 0;

  const allOnGoals = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  if (level.boxes.some((b) => live[b] === 0)) return null;

  // States in discovery order: their boxes, the player's square after the
  // push that made them, and the index of their parent state.
  const stateBoxes: number[][] = [level.boxes.slice()];
  const statePlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const index = new Map<string, number>();

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = floodRegion(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(stateKey(level.boxes, startLow), 0);

  let found = allOnGoals(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    floodRegion(level, occupied, statePlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const target = box + d;
        // The player must stand behind the box, the target square must be
        // open floor, and a box may never be pushed onto a dead square.
        if (seen[box - d] !== here || wall[target] === 1 || occupied[target] === 1 || live[target] === 0) continue;
        occupied[box] = 0;
        occupied[target] = 1;
        const frozen = isFrozenBlock(level, occupied, goal, target);
        let next: number[] | null = null;
        let key = '';
        if (!frozen) {
          next = boxes.slice();
          next[bi] = target;
          next.sort((a, b) => a - b);
          // After the push the player stands where the box stood.
          const low = floodRegion(level, occupied, box, mark, ++stamp, stack);
          key = stateKey(next, low);
        }
        occupied[target] = 0;
        occupied[box] = 1;
        if (frozen || index.has(key)) continue;
        if (stateBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, stateBoxes.length);
        stateBoxes.push(next as number[]);
        statePlayer.push(box);
        parent.push(head);
        if (allOnGoals(next as number[])) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the push path, then the moves: walk to each push's square, push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = stateBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b)) as number;
    const to = nextBoxes.find((b) => !boxes.includes(b)) as number;
    const d = to - from;
    const k = DX.findIndex((dx, i) => DY[i] * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null; // cannot happen: the push was reachable
    moves += walk + PUSH[k];
    player = from;
    boxes = nextBoxes.slice();
  }
  return { pushes: path.length, moves };
}

// ---------------------------------------------------------------------------
// Room decomposition
// ---------------------------------------------------------------------------

type Room = { squares: number[]; boxes: number[]; goals: number[]; done: boolean };

// The level's rooms, or null when it is no set of rooms. The dead squares of
// the player's row (the hallway: a box there reaches no goal) are cut out of
// the floor; each remaining connected component holding boxes is a room.
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] === 1 || cut[s] === 1 || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DY[k] * w + DX[k];
        if (wall[q] === 0 && cut[q] === 0 && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// ---------------------------------------------------------------------------
// Fallback: move-based A* (baseline-style), fixed expansion cap
// ---------------------------------------------------------------------------

// A plain A* over moves, used only when the push search gives up. It
// minimises moves, not pushes, so it is a safety net for a valid answer,
// not a route to full points. Deterministic: ties break by (f, h, order).
function solveByMoves(level: Level, maxExpansions: number): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const goalList = goals.slice();
  const manhattan = (a: number, b: number): number =>
    Math.abs((a % w) - (b % w)) + Math.abs(Math.floor(a / w) - Math.floor(b / w));
  // Admissible-ish guide: each box's distance to its nearest goal.
  const heuristic = (boxes: number[]): number => {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (const g of goalList) {
        const d = manhattan(b, g);
        if (d < best) best = d;
      }
      sum += best;
    }
    return sum;
  };
  const keyOf = (boxes: number[], player: number): string => player + '|' + boxes.join(',');
  const allOnGoals = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  if (allOnGoals(level.boxes)) return { pushes: 0, moves: '' };

  // Binary heap of [f, h, order, stateIndex]; smallest first.
  type Node = { boxes: number[]; player: number; g: number; pushes: number; parent: number; letter: string };
  const nodes: Node[] = [{ boxes: level.boxes.slice(), player: level.player, g: 0, pushes: 0, parent: -1, letter: '' }];
  const heap: number[] = [];
  const seen = new Map<string, number>();
  const h0 = heuristic(level.boxes);
  seen.set(keyOf(level.boxes, level.player), 0);
  heap.push(0);
  const prio = (i: number): [number, number, number] => [nodes[i].g + heuristic(nodes[i].boxes), heuristic(nodes[i].boxes), i];
  const less = (a: number, b: number): boolean => {
    const pa = prio(a);
    const pb = prio(b);
    return pa[0] < pb[0] || (pa[0] === pb[0] && (pa[1] < pb[1] || (pa[1] === pb[1] && pa[2] < pb[2])));
  };
  const heapPush = (i: number): void => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(heap[c], heap[p])) break;
      [heap[c], heap[p]] = [heap[p], heap[c]];
      c = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === p) break;
        [heap[m], heap[p]] = [heap[p], heap[m]];
        p = m;
      }
    }
    return top;
  };

  let expansions = 0;
  while (heap.length > 0) {
    const ni = heapPop();
    const node = nodes[ni];
    if (allOnGoals(node.boxes)) {
      let moves = '';
      for (let s = ni; nodes[s].parent >= 0; s = nodes[s].parent) moves = nodes[s].letter + moves;
      return { pushes: node.pushes, moves };
    }
    if (++expansions > maxExpansions) return null;
    const occupied = new Uint8Array(size);
    for (const b of node.boxes) occupied[b] = 1;
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const next = node.player + d;
      if (wall[next] === 1) continue;
      const boxes = node.boxes.slice();
      let pushes = node.pushes;
      let letter = WALK[k];
      if (occupied[next]) {
        const beyond = next + d;
        if (wall[beyond] === 1 || occupied[beyond] === 1) continue;
        boxes[boxes.indexOf(next)] = beyond;
        boxes.sort((a, b) => a - b);
        pushes++;
        letter = PUSH[k];
      }
      const key = keyOf(boxes, next);
      const prev = seen.get(key);
      if (prev !== undefined && nodes[prev].g <= node.g + 1) continue;
      const idx = nodes.length;
      nodes.push({ boxes, player: next, g: node.g + 1, pushes, parent: ni, letter });
      seen.set(key, idx);
      heapPush(idx);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-instance solver: room search first, then the fallbacks
// ---------------------------------------------------------------------------

function solveLevel(level: Level): string {
  // Already solved: no moves needed.
  const goalSet = new Set(level.goals);
  if (level.boxes.every((b) => goalSet.has(b))) return '';

  const rooms = roomsOf(level);
  if (rooms !== null) {
    // Room by room, with one larger retry per room when the run budget allows.
    let player = level.player;
    let moves = '';
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        const stand = other.done ? other.goals : other.boxes;
        for (const b of stand) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      let solved = solveByPushes(sub, ROOM_STATE_CAP);
      statesSpent += ROOM_STATE_CAP;
      if (solved === null && statesSpent + ROOM_RETRY_CAP <= RUN_STATE_BUDGET) {
        solved = solveByPushes(sub, ROOM_RETRY_CAP);
        statesSpent += ROOM_RETRY_CAP;
      }
      if (solved === null) {
        // This room will not yield: fall back to the whole level.
        const whole = solveByMoves(level, FALLBACK_EXPANSION_CAP);
        return whole === null ? '' : whole.moves;
      }
      moves += solved.moves;
      player = endSquare(level.w, player, solved.moves);
      room.done = true;
    }
    return moves;
  }

  // No rooms: push search over the whole level, then the move fallback.
  let solved = solveByPushes(level, ROOM_STATE_CAP);
  statesSpent += ROOM_STATE_CAP;
  if (solved === null && statesSpent + ROOM_RETRY_CAP <= RUN_STATE_BUDGET) {
    solved = solveByPushes(level, ROOM_RETRY_CAP);
    statesSpent += ROOM_RETRY_CAP;
  }
  if (solved !== null) return solved.moves;
  const whole = solveByMoves(level, FALLBACK_EXPANSION_CAP);
  return whole === null ? '' : whole.moves;
}

// ---------------------------------------------------------------------------
// Driver: every instance under /input, one solution.txt each, always written
// ---------------------------------------------------------------------------

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
    moves = solveLevel(level);
  } catch {
    // A failed instance must not kill the other four: empty answer, valid format.
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
