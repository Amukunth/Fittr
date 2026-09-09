/**
 * The Searching screen's wiring, with Supabase faked.
 *
 * The database suite proves the SQL; this proves the half that lives in JS
 * and that no test against Postgres can reach: that the realtime channel is
 * subscribed BEFORE the queue is entered, that entering happens once across
 * reconnects, that a `matched` row moves the fighter into the bout exactly
 * once however it arrives, and that leaving is what cancelling does.
 *
 * What it still does not prove is that Supabase actually delivers the
 * event — see "What is NOT verified" in BACKEND.md.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// `unknown` rather than a row type: this is the shape Realtime hands over,
// and the screen is what casts it.
type Handler = (payload: { new: unknown }) => void;
type SubscribeCallback = (status: string, err?: Error) => void;

interface FakeChannel {
  topic: string;
  handler: Handler | null;
  callback: SubscribeCallback | null;
  removed: boolean;
}

const mockChannels: FakeChannel[] = [];
const mockRpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let mockRpcHandler: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown };

jest.mock('../src/lib/supabase', () => ({
  channelName: (base: string) => base,
  supabase: {
    channel: (topic: string) => {
      const channel: FakeChannel = { topic, handler: null, callback: null, removed: false };
      mockChannels.push(channel);
      const api = {
        on: (_event: string, _filter: unknown, handler: Handler) => {
          channel.handler = handler;
          return api;
        },
        subscribe: (callback: SubscribeCallback) => {
          channel.callback = callback;
          return api;
        },
        _channel: channel,
      };
      return api;
    },
    removeChannel: (api: { _channel: FakeChannel }) => {
      api._channel.removed = true;
      return Promise.resolve('ok');
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ fn, args });
      return Promise.resolve(mockRpcHandler(fn, args));
    },
  },
}));

const mockMe = 'me-0000-0000-0000-000000000001';

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: mockMe, email: 'me@test.local' } } }),
}));

import { SearchingScreen } from '../src/screens/SearchingScreen';
import type { MatchmakingQueueRow } from '../src/types/database';

const REQUEST = {
  exerciseType: 'pushups',
  format: '1v1',
  maxParticipants: 2,
  stake: 250,
} as const;

function queueRow(over: Partial<MatchmakingQueueRow> = {}): MatchmakingQueueRow {
  return {
    id: 'queue-1',
    user_id: mockMe,
    exercise_type: 'pushups',
    format: '1v1',
    max_participants: 2,
    stake_points: 250,
    strength_tier: 'beginner',
    mmr: 1000,
    placement_complete: false,
    status: 'searching',
    challenge_id: 'lobby-1',
    match_id: null,
    lobby_size: 1,
    cancel_reason: null,
    joined_at: new Date().toISOString(),
    closed_at: null,
    ...over,
  };
}

function makeNavigation() {
  const calls = {
    replace: [] as Array<[string, unknown]>,
    navigate: [] as Array<[string, unknown]>,
    dispatched: 0,
  };
  let removeListener: ((event: {
    preventDefault: () => void;
    data: { action: unknown };
  }) => void) | null = null;
  const navigation = {
    replace: (name: string, params: unknown) => calls.replace.push([name, params]),
    navigate: (name: string, params?: unknown) => calls.navigate.push([name, params]),
    goBack: () => {
      // React Navigation runs beforeRemove listeners before popping.
      removeListener?.({ preventDefault: () => undefined, data: { action: 'POP' } });
    },
    canGoBack: () => true,
    dispatch: () => {
      calls.dispatched += 1;
    },
    addListener: (event: string, listener: typeof removeListener) => {
      if (event === 'beforeRemove') {
        removeListener = listener;
      }
      return () => {
        removeListener = null;
      };
    },
  };
  return { navigation, calls };
}

/** Renders the screen and returns the tree plus the navigation spy. */
async function mount() {
  const { navigation, calls } = makeNavigation();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SearchingScreen
        // The screen only uses route.params and the handful of navigation
        // methods above; the full typed props are not reachable here.
        route={{ params: REQUEST } as never}
        navigation={navigation as never}
      />,
    );
  });
  return { tree, calls };
}

/** Unmounting runs the teardown effect, which is itself under test. */
async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(async () => {
    tree.unmount();
  });
}

/** Everything the screen has rendered, as one string. */
function text(tree: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

async function flush() {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockChannels.length = 0;
  mockRpcCalls.length = 0;
  mockRpcHandler = () => ({ data: queueRow(), error: null });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('SearchingScreen', () => {
  it('subscribes before it enters the queue, and enters only once', async () => {
    const { tree } = await mount();

    // Subscribed, but nothing sent yet: entering before the subscription is
    // confirmed is the window in which a fill is missed.
    expect(mockChannels).toHaveLength(1);
    expect(mockRpcCalls).toHaveLength(0);

    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    expect(mockRpcCalls.map(c => c.fn)).toEqual(['enter_matchmaking']);
    expect(mockRpcCalls[0]!.args).toEqual({
      p_exercise_type: 'pushups',
      p_format: '1v1',
      p_stake_points: 250,
      p_max_participants: 2,
    });

    // A socket drop and rejoin must not re-enter: that would surrender the
    // fighter's place in the lobby. It asks where things stand instead.
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();
    expect(mockRpcCalls.map(c => c.fn)).toEqual(['enter_matchmaking', 'matchmaking_heartbeat']);

    await unmount(tree);
  });

  it('walks the fighter into the bout when the realtime event lands, once', async () => {
    const { tree, calls } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    expect(text(tree)).toContain('SEARCHING');

    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.handler!({
        new: queueRow({ status: 'matched', match_id: 'match-1', lobby_size: 2 }),
      });
    });
    expect(text(tree)).toContain("IT'S ON");

    // The same transition can also arrive by heartbeat; it must not start a
    // second countdown or navigate twice.
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.handler!({
        new: queueRow({ status: 'matched', match_id: 'match-1', lobby_size: 2 }),
      });
    });

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(calls.replace).toEqual([['MatchInProgress', { matchId: 'match-1' }]]);

    await unmount(tree);
  });

  it('goes straight in when the lobby filled on the entering call itself', async () => {
    mockRpcHandler = () => ({
      data: queueRow({ status: 'matched', match_id: 'match-2', lobby_size: 2 }),
      error: null,
    });
    const { tree, calls } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(calls.replace).toEqual([['MatchInProgress', { matchId: 'match-2' }]]);

    await unmount(tree);
  });

  it('ignores events for a queue row that is not the live one', async () => {
    const { tree, calls } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    // An older row of this user's, still inside the retention window.
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.handler!({
        new: queueRow({ id: 'queue-0', status: 'cancelled', cancel_reason: 'expired' }),
      });
    });
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(4000);
    });

    expect(calls.replace).toHaveLength(0);
    expect(text(tree)).not.toContain('SEARCH OVER');

    await unmount(tree);
  });

  it('shows why a search ended and offers another', async () => {
    const { tree } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.handler!({
        new: queueRow({ status: 'cancelled', cancel_reason: 'insufficient_points' }),
      });
    });

    const rendered = text(tree);
    expect(rendered).toContain('SEARCH OVER');
    expect(rendered).toContain('balance dropped under the stake');
    expect(rendered).toContain('SEARCH AGAIN');

    await unmount(tree);
  });

  it('surfaces an enter that the server refused', async () => {
    mockRpcHandler = () => ({ data: null, error: { message: 'round_open' } });
    const { tree } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    expect(text(tree)).toContain('You still have a round to fight');

    await unmount(tree);
  });

  it('gives up and leaves the queue after 30s with no match', async () => {
    const { tree } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();
    expect(text(tree)).toContain('SEARCHING');

    mockRpcHandler = () => ({ data: queueRow({ status: 'cancelled' }), error: null });
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    await flush();

    expect(mockRpcCalls.map(c => c.fn)).toContain('leave_matchmaking');
    const rendered = text(tree);
    expect(rendered).toContain('SEARCH OVER');
    expect(rendered).toContain('No fighters found in 30s');
    expect(rendered).toContain('SEARCH AGAIN');

    await unmount(tree);
  });

  it('does not give up if the lobby fills in the same instant as the 30s timeout', async () => {
    const { tree, calls } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    mockRpcHandler = () => ({
      data: queueRow({ status: 'matched', match_id: 'match-timeout' }),
      error: null,
    });
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    await flush();
    expect(text(tree)).toContain("IT'S ON");

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(calls.replace).toEqual([['MatchInProgress', { matchId: 'match-timeout' }]]);

    await unmount(tree);
  });

  it('leaves the queue when the fighter backs out, and tears the channel down', async () => {
    const { tree, calls } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    mockRpcHandler = () => ({ data: queueRow({ status: 'cancelled' }), error: null });
    await ReactTestRenderer.act(async () => {
      // The same path the cancel button, the close circle and the hardware
      // back button all take.
      tree.root.findByProps({ accessibilityLabel: 'Cancel search' }).props.onPress();
    });
    await flush();

    expect(mockRpcCalls.map(c => c.fn)).toContain('leave_matchmaking');
    expect(calls.dispatched).toBe(1);

    await unmount(tree);
    expect(mockChannels[0]!.removed).toBe(true);
  });

  it('takes the fighter into the bout when the lobby filled as they cancelled', async () => {
    const { tree, calls } = await mount();
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    // The stake has already moved: the only correct answer is to go.
    mockRpcHandler = () => ({
      data: queueRow({ status: 'matched', match_id: 'match-3' }),
      error: null,
    });
    await ReactTestRenderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Cancel search' }).props.onPress();
    });
    await flush();

    expect(calls.dispatched).toBe(0);
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(calls.replace).toEqual([['MatchInProgress', { matchId: 'match-3' }]]);

    await unmount(tree);
  });

  it('shows the lobby filling for a Group Battle', async () => {
    mockRpcHandler = () => ({
      data: queueRow({ format: 'pooled', max_participants: 4, lobby_size: 1 }),
      error: null,
    });
    const { navigation } = makeNavigation();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <SearchingScreen
          route={{ params: { ...REQUEST, format: 'pooled', maxParticipants: 4 } } as never}
          navigation={navigation as never}
        />,
      );
    });
    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.callback!('SUBSCRIBED');
    });
    await flush();

    expect(text(tree)).toContain('SPOTS CLAIMED');
    expect(text(tree)).toContain('3 to go');

    await ReactTestRenderer.act(async () => {
      mockChannels[0]!.handler!({
        new: queueRow({ format: 'pooled', max_participants: 4, lobby_size: 3 }),
      });
    });
    expect(text(tree)).toContain('1 to go');

    await unmount(tree);
  });
});
