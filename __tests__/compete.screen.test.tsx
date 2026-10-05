/**
 * The Compete screen and the per-exercise mode screen, with Supabase faked.
 *
 * score.db.test.ts proves the SQL and score.test.ts the arithmetic; this
 * proves the half in between: that the featured pooled card renders what
 * pooled_featured() returned and leads to the Pooled screen, that an
 * exercise tile leads to that exercise's mode screen, that the three panes
 * mount with their tabs, that the 1v1 WIN display follows the stake
 * stepper, that Blitz shows the max payout for the stake, and that PLAY on
 * the 1v1 pane enters the queue with the request the pane built.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type {
  BlitzPreviewRow,
  FitnessProfileRow,
  PooledFeaturedRow,
  StreakPreviewRow,
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
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'maybeSingle', 'single', 'insert']) {
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
  useFocusEffect: (callback: () => void) => {
    const React_ = require('react');
    React_.useEffect(callback, [callback]);
  },
  useNavigation: () => ({ navigate: () => undefined }),
}));

import { CompeteScreen } from '../src/screens/CompeteScreen';
import { ExerciseModesScreen } from '../src/screens/ExerciseModesScreen';

// ── fixtures ────────────────────────────────────────────────────────────

const PROFILE: FitnessProfileRow = {
  id: 'p1',
  user_id: mockMe,
  strength_tier: 'beginner',
  points_balance: 500,
  display_name: 'Rey',
  username: 'rey',
  avatar_url: null,
  gender: null,
  age_band: null,
  trophies: 0,
  current_league: 'bronze',
  total_wins: 0,
  total_losses: 0,
  total_ties: 0,
  current_streak: 0,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const FEATURED: PooledFeaturedRow = {
  id: 'pool-1',
  exercise_type: 'pushups',
  title: 'Pooled Push-ups',
  description: 'One max set of push-ups.',
  entry_fee: 100,
  max_entries: 6,
  entries: 2,
  pool_points: 200,
  max_pool_points: 600,
  match_id: 'match-pool-1',
  entered: false,
  played: false,
  filled_at: null,
  settled_at: null,
  created_at: '2026-09-19T00:00:00Z',
  prize_shares_bp: [5000, 3000, 2000],
  server_now: '2026-09-19T12:00:00Z',
};

const BLITZ: BlitzPreviewRow = {
  exercise_type: 'pushups',
  mmr: 1000,
  placement_complete: false,
  calibrated_to_me: false,
  threshold_raw: 30,
  benchmark_raw: 45,
  threshold_score: 2550,
  benchmark_score: 3825,
  threshold_rating: 1000,
  benchmark_rating: 1320,
  breakeven_bp: 10000,
  max_bp: 25000,
  reference_quality_bp: 8500,
};

const STREAK: StreakPreviewRow = {
  exercise_type: 'pushups',
  mmr: 1000,
  placement_complete: false,
  calibrated_to_me: false,
  stage1_target: 1105,
  stage2_target: 1530,
  stage3_target: 2040,
  stage1_rating: 800,
  stage2_rating: 900,
  stage3_rating: 1000,
  payout_bp: 40000,
  state: 'idle',
  run_id: null,
  is_ranked: null,
  stake_points: null,
  stakes_paid: null,
  current_stage: null,
  failed_stage: null,
  failed_at: null,
  buyback_until: null,
  completed_at: null,
  cooldown_until: null,
  payout_points: null,
  pending_match_id: null,
  server_now: '2026-09-19T12:00:00Z',
  reference_quality_bp: 8500,
};

function makeNavigation() {
  const calls = {
    navigate: [] as Array<[string, unknown]>,
    replace: [] as Array<[string, unknown]>,
  };
  const navigation = {
    navigate: (name: string, params?: unknown) => calls.navigate.push([name, params]),
    replace: (name: string, params?: unknown) => calls.replace.push([name, params]),
    goBack: () => undefined,
    canGoBack: () => true,
    addListener: () => () => undefined,
  };
  return { navigation, calls };
}

async function flush() {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Every string the tree rendered, joined. Walks children only: the Compete
 * screen hands its ScrollView a RefreshControl element as a prop, and
 * stringifying props would chase that element's fibre back into itself.
 */
function text(tree: ReactTestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: ReactTestRenderer.ReactTestRendererNode | ReactTestRenderer.ReactTestRendererNode[] | null) => {
    if (node === null) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    walk(node.children);
  };
  walk(tree.toJSON());
  return out.join('\n');
}

beforeEach(() => {
  mockChannels.length = 0;
  mockRpcCalls.length = 0;
  mockRpc = fn => {
    switch (fn) {
      case 'pooled_featured':
        return { data: FEATURED, error: null };
      case 'blitz_preview':
        return { data: BLITZ, error: null };
      case 'streak_preview':
        return { data: STREAK, error: null };
      default:
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
    }
  };
  mockTable = table => {
    if (table === 'fitness_profiles') {
      return { data: PROFILE, error: null };
    }
    return { data: [], error: null };
  };
});

// ── Compete ─────────────────────────────────────────────────────────────

describe('CompeteScreen', () => {
  async function mount() {
    const { navigation, calls } = makeNavigation();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <CompeteScreen route={{ params: undefined } as never} navigation={navigation as never} />,
      );
    });
    await flush();
    return { tree, calls };
  }

  it('renders the featured pooled card from pooled_featured()', async () => {
    const { tree } = await mount();
    expect(mockRpcCalls.map(c => c.fn)).toContain('pooled_featured');
    const rendered = text(tree);
    expect(rendered).toContain('Pooled Push-ups');
    expect(rendered).toContain('FEATURED · POOLED');
    expect(rendered).toContain('2 OF 6 SEATS FILLED');
    expect(rendered).toContain('ENTER · 100 PTS');
    expect(rendered).toContain('OF 600');
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('leads from the card to the Pooled screen and from a tile to the exercise screen', async () => {
    const { tree, calls } = await mount();
    await ReactTestRenderer.act(async () => {
      tree.root
        .findAllByProps({ accessibilityLabel: 'Pooled Push-ups, prize pool 200 PTS, 2 of 6 seats filled' })
        .find(n => typeof n.props.onPress === 'function')!
        .props.onPress();
    });
    expect(calls.navigate).toContainEqual(['Pooled', undefined]);

    await ReactTestRenderer.act(async () => {
      tree.root
        .findAllByProps({ accessibilityLabel: 'Plank' })
        .find(n => typeof n.props.onPress === 'function')!
        .props.onPress();
    });
    expect(calls.navigate).toContainEqual(['ExerciseModes', { exerciseType: 'plank' }]);

    // Race is not on the card yet: its tile says so and is disabled.
    const race = tree.root
      .findAllByProps({ accessibilityLabel: '1-Mile Race, coming soon' })
      .find(n => n.props.disabled !== undefined);
    expect(race?.props.disabled).toBe(true);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });
});

// ── ExerciseModes ───────────────────────────────────────────────────────

describe('ExerciseModesScreen', () => {
  async function mount(params: { exerciseType: 'pushups' | 'plank' | 'wallsit' | 'race'; mode?: '1v1' | 'blitz' | 'streak' }) {
    const { navigation, calls } = makeNavigation();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ExerciseModesScreen route={{ params } as never} navigation={navigation as never} />,
      );
    });
    await flush();
    return { tree, calls };
  }

  it('mounts the three tabs and the three panes with their previews', async () => {
    const { tree } = await mount({ exerciseType: 'pushups' });
    const rendered = text(tree);
    for (const tab of ['1v1', 'Blitz', 'Streak']) {
      expect(rendered).toContain(tab);
    }
    expect(mockRpcCalls.map(c => c.fn).sort()).toEqual(['blitz_preview', 'streak_preview']);
    // 1v1: WIN is both stakes at the default 100.
    expect(rendered).toContain('WIN');
    expect(rendered).toContain('200');
    // Blitz: the max payout for the stake, and the break-even score.
    expect(rendered).toContain('MAX PAYOUT');
    expect(rendered).toContain('250');
    expect(rendered).toContain('2,550');
    expect(rendered).toContain('≈ 30 REPS AT 85% FORM');
    // Streak: three stage cards with scores to beat.
    expect(rendered.split('SCORE TO BEAT').length - 1).toBe(3);
    expect(rendered).toContain('1,105');
    expect(rendered).toContain('2,040');
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('moves the WIN display with the stake stepper and enters the queue on PLAY', async () => {
    const { tree, calls } = await mount({ exerciseType: 'pushups' });
    const raise = tree.root
      .findAllByProps({ accessibilityLabel: 'Raise stake' })
      .find(n => typeof n.props.onPress === 'function')!;
    await ReactTestRenderer.act(async () => {
      raise.props.onPress();
    });
    // 100 -> 250: WIN is now 500.
    expect(text(tree)).toContain('500');

    const play = tree.root.findAllByProps({ label: 'PLAY' })[0]!;
    await ReactTestRenderer.act(async () => {
      play.props.onPress();
    });
    expect(calls.navigate).toContainEqual([
      'Searching',
      { exerciseType: 'pushups', format: '1v1', maxParticipants: 2, stake: 250, mode: 'casual' },
    ]);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('starts a Blitz from its pane and goes straight to the camera', async () => {
    mockRpc = fn => {
      if (fn === 'blitz_start') {
        return { data: { match_id: 'match-blitz-1' }, error: null };
      }
      if (fn === 'blitz_preview') {
        return { data: BLITZ, error: null };
      }
      if (fn === 'streak_preview') {
        return { data: STREAK, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    };
    const { tree, calls } = await mount({ exerciseType: 'pushups', mode: 'blitz' });
    const play = tree.root.findAllByProps({ label: 'PLAY' })[1]!;
    await ReactTestRenderer.act(async () => {
      play.props.onPress();
    });
    await flush();
    const start = mockRpcCalls.find(c => c.fn === 'blitz_start');
    expect(start?.args).toEqual({ p_exercise: 'pushups', p_stake: 100, p_is_ranked: false });
    expect(calls.replace).toEqual([['MatchInProgress', { matchId: 'match-blitz-1' }]]);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('says race is not on the card yet instead of offering modes', async () => {
    const { tree } = await mount({ exerciseType: 'race' });
    expect(text(tree)).toContain('NOT ON');
    expect(mockRpcCalls).toHaveLength(0);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });
});
