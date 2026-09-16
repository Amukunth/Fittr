import type {
  ChallengeFormat,
  ChallengeType,
  RankedMode,
} from '../types/database';

/** What a fighter asked the queue for. Searching re-uses it for "try again". */
export interface BoutRequest {
  exerciseType: ChallengeType;
  /** Never a solo format: Blitz and Streak do not queue. */
  format: Extract<ChallengeFormat, '1v1' | 'pooled'>;
  /** 2 for 1v1, 3..6 for a Group Battle. */
  maxParticipants: number;
  stake: number;
  /**
   * Chosen on Find a Bout for this attempt only. Carried in the route params
   * rather than held anywhere durable, which is what makes "never remembered
   * from last time" structural: a new search is a new navigation, and a new
   * navigation defaults it to casual again.
   */
  mode: RankedMode;
}

export type RootStackParamList = {
  Login: undefined;
  Onboarding: undefined;
  Home: undefined;
  /** Pick exercise, format, stake and ranked/casual, then tap Find a Bout. */
  FindBout: undefined;
  /** The live queue. Enters on mount, leaves on cancel or unmount. */
  Searching: BoutRequest;
  /**
   * Blitz set-up: the calibrated tier ladder, the stake, the ranked switch.
   * Nothing is staked until the button on this screen is tapped.
   */
  BlitzPre: { exerciseType: ChallengeType };
  /**
   * Streak set-up: all three stage targets, the stake, the ranked switch —
   * or a locked state with a countdown when a win is still cooling down, or
   * a resume/buy-back state when a run is already under way.
   */
  StreakPre: { exerciseType: ChallengeType };
  /**
   * Where a Streak stage lands after the camera: stage cleared, run failed
   * (with the buy-back countdown) or run won. Reached by run id rather than
   * match id because all three states are about the RUN, and the run
   * outlives any one stage's match.
   */
  StreakRun: { runId: string };
  MatchInProgress: { matchId: string };
  Results: { matchId: string };
  /** The trophy ladder: league, leaderboard, rank history. */
  Rank: undefined;
  Profile: undefined;
  Settings: undefined;
  ChangePassword: undefined;
  TwoFactor: undefined;
  Sessions: undefined;
  ConnectedAccounts: undefined;
  Deposit: undefined;
  Cashout: undefined;
  LinkedAccounts: undefined;
  Transactions: undefined;
};
