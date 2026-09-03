export type RootStackParamList = {
  Login: undefined;
  Home: undefined;
  CreateChallenge: undefined;
  ChallengeDetail: { challengeId: string };
  MatchInProgress: { matchId: string };
  Results: { matchId: string };
  Profile: undefined;
};
