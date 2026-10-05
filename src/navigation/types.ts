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
  /** 2 for 1v1, 3..6 for a queue-formed Group Battle. */
  maxParticipants: number;
  stake: number;
  /**
   * Chosen on the exercise's mode screen for this attempt only. Carried in
   * the route params rather than held anywhere durable, which is what makes
   * "never remembered from last time" structural: a new search is a new
   * navigation, and a new navigation defaults it to casual again.
   */
  mode: RankedMode;
}

/**
 * The three tabs of an exercise's mode screen, in the order they are laid
 * out. Pooled is not one of them: the featured competition is one card on
 * Compete, not a per-exercise choice.
 */
export type CompeteMode = '1v1' | 'blitz' | 'streak';

export type RootStackParamList = {
  Login: undefined;
  Onboarding: undefined;
  /**
   * The first tab: the featured pooled competition, the fighter's open
   * rounds, and the exercise grid. Replaces the old Bouts and Find screens.
   */
  Compete: undefined;
  /**
   * One exercise, three modes side by side (1v1 / Blitz / Streak), swiped
   * or tabbed between. `mode` picks the tab to open on; `fresh` tells the
   * Streak tab to offer a new run even while a failed one is still inside
   * its revive window.
   */
  ExerciseModes: { exerciseType: ChallengeType; mode?: CompeteMode; fresh?: boolean };
  /** The featured pooled competition in full, with its entry button. */
  Pooled: undefined;
  /** The live queue. Enters on mount, leaves on cancel or unmount. */
  Searching: BoutRequest;
  /**
   * Where a Streak stage lands after the camera: stage cleared, run failed
   * (with the revive countdown) or run won. Reached by run id rather than
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
