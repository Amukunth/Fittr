import type { ChallengeFormat, ChallengeType } from '../types/database';

/** What a fighter asked the queue for. Searching re-uses it for "try again". */
export interface BoutRequest {
  exerciseType: ChallengeType;
  format: ChallengeFormat;
  /** 2 for 1v1, 3..6 for a Group Battle. */
  maxParticipants: number;
  stake: number;
}

export type RootStackParamList = {
  Login: undefined;
  Onboarding: undefined;
  Home: undefined;
  /** Pick exercise, format and stake, then tap Find a Bout. */
  FindBout: undefined;
  /** The live queue. Enters on mount, leaves on cancel or unmount. */
  Searching: BoutRequest;
  MatchInProgress: { matchId: string };
  Results: { matchId: string };
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
