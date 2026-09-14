/**
 * The Rank screen's wiring, with Supabase faked.
 *
 * rank.db.test.ts proves the SQL and league.test.ts proves the display
 * rules; this proves the half in between that neither can reach -- that the
 * hero renders what rank_standing() returned, that the leaderboard pins the
 * caller's row when it is off the page, that switching scope asks the
 * server for the other board, and that a realtime trophy change raises the
 * count and celebrates it.
 *
 * What it still does not prove is that Supabase actually delivers the
 * event -- see "What is NOT verified" in BACKEND.md.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type {
  LeaderboardRow,
  LeagueTier,
  RankHistoryRow,
  RankStandingRow,
} from '../src/types/database';

type Handler = (payload: { new: unknown }) => void;

interface FakeChannel {
  topic: string;
  handler: Handler | null;
  removed: boolean;
}

const mockChannels: FakeChannel[] = [];
const mockRpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let mockRpc: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
let mockTable: (table: string) => { data: unknown; error: unknown };

/** A chainable, awaitable stand-in for a PostgREST query builder. */
function mockMakeQuery(result: { data: unknown; error: unknown }) {
  const api: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'maybeSingle', 'single']) {
    api[method] = () => api;
  }
  api.then = (resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return api;
}

jest.mock('../src/lib/supabase', () => ({
  channelName: (base: string) => base,
  supabase: {
    channel: (topic: string) => {
      const channel: FakeChannel = { topic, handler: null, removed: false };
      mockChannels.push(channel);
      const api = {
        on: (_event: string, _filter: unknown, handler: Handler) => {
          channel.handler = handler;
          return api;
        },
        subscribe: () => api,
        _channel: channel,
      };
      return api;
    },
    removeChannel: (api: { _channel: FakeChannel }) => {
      api._channel.removed = true;
      return Promise.resolve('ok');
    },
    rpc: (fn: string, args: Record<string, unknown> = {}) => {
      mockRpcCalls.push({ fn, args });
      return Promise.resolve(mockRpc(fn, args));
    },
    from: (table: string) => mockMakeQuery(mockTable(table)),
  },
}));

const mockMe = 'me-0000-0000-0000-000000000001';

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { id: mockMe, email: 'rey@test.local', user_metadata: { handle: 'rey' } } },
  }),
}));

jest.mock('@react-navigation/native', () => ({
  // The screen only needs the callback run once on mount; there is no
  // blur/focus cycle in a test renderer.
  useFocusEffect: (callback: () => void) => {
    const React_ = require('react');
    React_.useEffect(callback, [callback]);
  },
  useNavigation: () => ({ navigate: () => undefined }),
}));

import { RankScreen } from '../src/screens/RankScreen';
import { invalidateLeaderboard } from '../src/hooks/useLeaderboard';
import { invalidateLeagueTiers } from '../src/hooks/useLeagueTiers';
import { resetBadge } from '../src/lib/rankBadge';

// ── fixtures ────────────────────────────────────────────────────────────

const TIERS = [
  { id: 't1', name: 'bronze', min_trophies: 0, max_wager_cents: 1000, color_hex: '#CD7F32' },
  { id: 't2', name: 'silver', min_trophies: 50, max_wager_cents: 2500, color_hex: '#C0C0C0' },
  { id: 't3', name: 'gold', min_trophies: 150, max_wager_cents: 5000, color_hex: '#FFD700' },
  { id: 't4', name: 'platinum', min_trophies: 300, max_wager_cents: 10000, color_hex: '#00CFCF' },
  { id: 't5', name: 'diamond', min_trophies: 500, max_wager_cents: 25000, color_hex: '#B9F2FF' },
];

function standing(over: Partial<RankStandingRow> = {}): RankStandingRow {
  return {
    user_id: mockMe,
    trophies: 247,
    current_league: 'gold',
    total_wins: 21,
    total_losses: 9,
    total_ties: 0,
    current_streak: 4,
    global_rank: 42,
    ...over,
  };
}

function boardRow(over: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    rank: 1,
    user_id: 'other-1',
    username: 'marcus',
    display_name: null,
    avatar_url: null,
    trophies: 980,
    league: 'diamond',
    is_me: false,
    ...over,
  };
}

function historyRow(over: Partial<RankHistoryRow> = {}): RankHistoryRow {
  return {
    id: 'h1',
    user_id: mockMe,
    event_type: 'win',
    trophy_delta: 14,
    trophy_balance: 247,
    opponent_id: 'other-1',
    match_id: 'm1',
    created_at: new Date().toISOString(),
    ...over,
  };
}

/** The profile row shape Realtime hands over on an UPDATE. */
function profileRow(trophies: number, league: LeagueTier) {
  return {
    user_id: mockMe,
    trophies,
    current_league: league,
    total_wins: 22,
    total_losses: 9,
    total_ties: 0,
    current_streak: 5,
  };
}

// ── harness ─────────────────────────────────────────────────────────────

let currentStanding = standing();
let currentBoard: LeaderboardRow[] = [];
let currentSelf: LeaderboardRow | null = null;
let currentHistory: RankHistoryRow[] = [];

let live: ReactTestRenderer.ReactTestRenderer | null = null;

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      // The screen only uses navigation.navigate; the full typed props are
      // not reachable here.
      <RankScreen route={{} as never} navigation={{ navigate: () => undefined } as never} />,
    );
  });
  live = tree;
  return tree;
}

async function flush() {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface RenderedNode {
  children?: unknown;
}

/**
 * Every string the screen has rendered, joined.
 *
 * A walk rather than JSON.stringify, because the ScrollView's
 * refreshControl prop is a React element and carries a fiber back-reference
 * that stringify cannot follow. Only `children` is visited, so props never
 * enter it.
 */
function text(tree: ReactTestRenderer.ReactTestRenderer): string {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      walk((node as RenderedNode).children);
    }
  };
  walk(tree.toJSON());
  return found.join(' ');
}

/** Every string under one test instance, for finding a control by its label. */
function instanceText(node: ReactTestRenderer.ReactTestInstance): string {
  const found: string[] = [];
  const walk = (n: ReactTestRenderer.ReactTestInstance | string): void => {
    if (typeof n === 'string') {
      found.push(n);
      return;
    }
    n.children.forEach(walk);
  };
  walk(node);
  return found.join(' ');
}

/** The pressable control whose own text is `label`. */
function control(
  tree: ReactTestRenderer.ReactTestRenderer,
  label: string,
): ReactTestRenderer.ReactTestInstance {
  const hit = tree.root
    .findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityRole === 'button' &&
        instanceText(node).trim() === label,
    )
    .pop();
  if (!hit) {
    throw new Error(`no control labelled "${label}" on screen`);
  }
  return hit;
}

beforeEach(() => {
  mockChannels.length = 0;
  mockRpcCalls.length = 0;
  currentStanding = standing();
  currentBoard = [];
  currentSelf = null;
  currentHistory = [];
  invalidateLeaderboard();
  invalidateLeagueTiers();
  resetBadge();
  // The hero badge, the shimmer and the celebration all run Animated.loop
  // forever by design. Real timers would leave the test spinning on them.
  jest.useFakeTimers();

  mockRpc = fn => {
    switch (fn) {
      case 'rank_standing':
        return { data: currentStanding, error: null };
      case 'leaderboard_page':
        return { data: currentBoard, error: null };
      case 'leaderboard_self':
        return { data: currentSelf, error: null };
      default:
        return { data: null, error: null };
    }
  };
  mockTable = table => {
    switch (table) {
      case 'league_tiers':
        return { data: TIERS, error: null };
      case 'rank_history':
        return { data: currentHistory, error: null };
      case 'fitness_profiles':
        return { data: { trophies: 247, current_league: 'gold' }, error: null };
      default:
        return { data: [], error: null };
    }
  };
});

afterEach(async () => {
  // Unmounted inside act, so the shared badge store has no listeners left
  // from this test when the next one resets it.
  if (live) {
    const tree = live;
    live = null;
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ── the hero ────────────────────────────────────────────────────────────

describe('the hero', () => {
  it('shows the league, the count, the target and the global rank', async () => {
    const tree = await mount();
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('Gold');
    expect(rendered).toContain('247');
    expect(rendered).toContain('247 / 300 TO PLATINUM');
    expect(rendered).toContain('53 TO GO');
    expect(rendered).toContain('RANK #42 GLOBALLY');
  });

  it('replaces the bar with Max Rank at the top of the ladder', async () => {
    currentStanding = standing({ trophies: 640, current_league: 'diamond' });
    const tree = await mount();
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('MAX RANK');
    expect(rendered).not.toContain('TO GO');
    expect(rendered).not.toContain('TO DIAMOND');
  });

  it('reads the thresholds the server sent, not only the mirrored ones', async () => {
    mockTable = table =>
      table === 'league_tiers'
        ? { data: [...TIERS.slice(0, 3), { ...TIERS[3], min_trophies: 260 }, TIERS[4]], error: null }
        : { data: [], error: null };
    const tree = await mount();
    await flush();

    expect(text(tree)).toContain('247 / 260 TO PLATINUM');
  });
});

// ── the record ──────────────────────────────────────────────────────────

describe('the record', () => {
  it('shows wins, losses, streak and a win rate that counts ties', async () => {
    currentStanding = standing({ total_wins: 3, total_losses: 1, total_ties: 2 });
    const tree = await mount();
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('WINS');
    expect(rendered).toContain('LOSSES');
    expect(rendered).toContain('STREAK');
    // 3 of 6, not 3 of 4: the same rule the Profile screen uses.
    expect(rendered).toContain('50% OF THE CARD');
  });

  it('says so rather than showing 0% before the first bout', async () => {
    currentStanding = standing({ total_wins: 0, total_losses: 0, total_ties: 0 });
    const tree = await mount();
    await flush();

    expect(text(tree)).toContain('NO BOUTS YET');
  });
});

// ── league rewards ──────────────────────────────────────────────────────

describe('league rewards', () => {
  it('marks the current league, the ones below it and the ones above', async () => {
    const tree = await mount();
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('CURRENT');
    expect(rendered).toContain('COMPLETED');
    expect(rendered).toContain('LOCKED');
    // The ceilings, in dollars, from the rows the server sent.
    expect(rendered).toContain('$10 max wager');
    expect(rendered).toContain('$250 max wager');
  });
});

// ── the leaderboard ─────────────────────────────────────────────────────

describe('the leaderboard', () => {
  it('asks for the global board first, twenty at a time', async () => {
    await mount();
    await flush();

    const page = mockRpcCalls.find(c => c.fn === 'leaderboard_page');
    expect(page!.args).toEqual({ p_scope: 'global', p_limit: 20, p_offset: 0 });
    expect(mockRpcCalls.some(c => c.fn === 'leaderboard_self')).toBe(true);
  });

  it('pins the caller below a divider when their row is off the page', async () => {
    currentBoard = [
      boardRow({ rank: 1, user_id: 'a', username: 'marcus' }),
      boardRow({ rank: 2, user_id: 'b', username: 'dee', trophies: 900 }),
    ];
    currentSelf = boardRow({
      rank: 42,
      user_id: mockMe,
      username: 'rey',
      trophies: 247,
      league: 'gold',
      is_me: true,
    });

    const tree = await mount();
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('YOUR POSITION');
    expect(rendered).toContain('@rey');
    expect(rendered).toContain('@marcus');
  });

  it('does not pin a second copy when the caller is already on the page', async () => {
    const me = boardRow({ rank: 2, user_id: mockMe, username: 'rey', is_me: true });
    currentBoard = [boardRow({ rank: 1, user_id: 'a', username: 'marcus' }), me];
    currentSelf = me;

    const tree = await mount();
    await flush();

    expect(text(tree)).not.toContain('YOUR POSITION');
  });

  it('asks the server for the other board when the scope is switched', async () => {
    currentBoard = [boardRow()];
    const tree = await mount();
    await flush();

    const friends = control(tree, 'Friends');

    await ReactTestRenderer.act(async () => {
      friends.props.onPress();
    });
    await flush();

    expect(
      mockRpcCalls.filter(c => c.fn === 'leaderboard_page').map(c => c.args.p_scope),
    ).toEqual(['global', 'friends']);
  });

  it('says what an empty friends board means, rather than showing nothing', async () => {
    currentBoard = [];
    const tree = await mount();
    await flush();

    expect(text(tree)).toContain('THE BOARD IS EMPTY');
  });
});

// ── rank history ────────────────────────────────────────────────────────

describe('rank history', () => {
  it('renders the timeline newest first with its balances', async () => {
    currentHistory = [
      historyRow({ id: 'h1', event_type: 'promotion', trophy_delta: 0, trophy_balance: 247 }),
      historyRow({ id: 'h2', event_type: 'win', trophy_delta: 14, trophy_balance: 247 }),
      historyRow({
        id: 'h3',
        event_type: 'loss',
        trophy_delta: -6,
        trophy_balance: 233,
        opponent_id: 'other-2',
      }),
    ];
    const tree = await mount();
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('Promoted to Gold');
    expect(rendered).toContain('Won 14 trophies vs @other1');
    expect(rendered).toContain('Lost 6 trophies');
    expect(rendered).toContain('247 trophies');
  });

  it('shows the on-brand empty state before the first bout', async () => {
    currentHistory = [];
    const tree = await mount();
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('NO RANK');
    expect(rendered).toContain('Win your first bout to earn trophies');
    expect(rendered).toContain('TAKE A BOUT');
  });
});

// ── realtime ────────────────────────────────────────────────────────────

describe('a trophy landing while the screen is open', () => {
  function pushProfile(trophies: number, league: LeagueTier) {
    const channel = mockChannels.find(c => c.topic.startsWith('rank:'));
    expect(channel).toBeTruthy();
    return ReactTestRenderer.act(async () => {
      channel!.handler!({ new: profileRow(trophies, league) });
    });
  }

  it('raises the count without a refresh and celebrates the gain', async () => {
    const tree = await mount();
    await flush();
    expect(text(tree)).toContain('247');

    await pushProfile(264, 'gold');
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('264');
    expect(rendered).toContain('TROPHIES');
    expect(rendered).toContain('+17');
  });

  it('announces the league by name when the gain was a promotion', async () => {
    const tree = await mount();
    await flush();

    await pushProfile(312, 'platinum');
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('PROMOTED');
    expect(rendered).toContain('Platinum league');
  });

  it('does not celebrate a loss', async () => {
    const tree = await mount();
    await flush();

    await pushProfile(241, 'gold');
    await flush();
    const rendered = text(tree);

    expect(rendered).toContain('241');
    expect(rendered).not.toContain('PROMOTED');
    expect(rendered).not.toContain('TROPHIES EARNED');
  });

  it('re-reads the timeline and the board, which the change has moved', async () => {
    await mount();
    await flush();
    const before = mockRpcCalls.filter(c => c.fn === 'leaderboard_page').length;

    await pushProfile(264, 'gold');
    await flush();

    expect(
      mockRpcCalls.filter(c => c.fn === 'leaderboard_page').length,
    ).toBeGreaterThan(before);
  });

  it('ignores a profile update that did not move the ladder', async () => {
    // Every stake and every payout updates this same row. Re-counting the
    // global rank for one would be a round trip per bout for nothing.
    await mount();
    await flush();
    const before = mockRpcCalls.filter(c => c.fn === 'rank_standing').length;

    await pushProfile(247, 'gold');
    await flush();

    expect(mockRpcCalls.filter(c => c.fn === 'rank_standing')).toHaveLength(before);
  });

  it('closes its channel when the screen goes away', async () => {
    const tree = await mount();
    await flush();

    live = null;
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });

    expect(mockChannels.filter(c => c.topic.startsWith('rank:')).every(c => c.removed)).toBe(
      true,
    );
  });
});
