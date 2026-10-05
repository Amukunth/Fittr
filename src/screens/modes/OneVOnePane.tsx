import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { fmtPoints } from '../../lib/format';
import type { RankedMode } from '../../types/database';
import { MODE_NOTE, RANKED_NOTE, SCORE_RULE, UNIT } from '../../theme/copy';
import { colors } from '../../theme/tokens';
import { Dock, Label, Notice, RankedToggle } from '../../theme/ui';
import {
  OpenRoundBlock,
  StakeDock,
  WinDisplay,
  defaultStake,
  paneStyles,
  type PaneProps,
} from './PaneShared';

/** A 1v1 is always two seats. */
const SEATS = 2;

/**
 * The 1v1 tab: the WIN display, the ranked switch, and the stake control
 * with the button that enters the live queue. Nothing is written here; the
 * Searching screen owns the queue, so backing out never leaves a half-made
 * bout behind.
 */
export function OneVOnePane({
  exerciseType,
  navigation,
  balance,
  openRound,
  onGoToRound,
}: PaneProps) {
  const [stake, setStake] = useState<number>(() => defaultStake(balance));
  // Casual on every mount. This screen is pushed fresh each time, so the
  // mode is never carried over from the last attempt. See RankedToggle.
  const [mode, setMode] = useState<RankedMode>('casual');

  const affordable = balance === null || stake <= balance;
  const pot = stake * SEATS;

  const find = () => {
    navigation.navigate('Searching', {
      exerciseType,
      format: '1v1',
      maxParticipants: SEATS,
      stake,
      mode,
    });
  };

  return (
    <View style={paneStyles.pane}>
      <ScrollView
        contentContainerStyle={paneStyles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={paneStyles.note}>{MODE_NOTE['1v1']}</Text>

        {/* The payout if it goes your way: both stakes. Updates with the stepper. */}
        <WinDisplay
          amount={pot}
          sub={`Both stakes to the higher score. Net +${fmtPoints(stake)} ${UNIT} on a win, −${fmtPoints(stake)} on a loss, refunded on a dead heat.`}
        />

        <View>
          <Label size={11} style={paneStyles.fieldLabel}>
            THIS BOUT
          </Label>
          <RankedToggle value={mode} onChange={setMode} />
          <Text style={paneStyles.helper}>{RANKED_NOTE[mode]}</Text>
        </View>

        <Notice icon="seal-check" iconColor={colors.accent}>
          {SCORE_RULE}
        </Notice>

        {openRound ? <OpenRoundBlock openRound={openRound} onGoToRound={onGoToRound} /> : null}
      </ScrollView>

      <Dock style={paneStyles.dock}>
        <View style={paneStyles.summary}>
          <Label size={11} color={colors.secondary} tracking={0.12}>
            LIVE MATCHMAKING · AT YOUR RANK
          </Label>
          <Label size={11} color={colors.secondary} tracking={0.12}>
            {`YOU HAVE ${balance === null ? '—' : fmtPoints(balance)}`}
          </Label>
        </View>
        <StakeDock
          stake={stake}
          onStake={setStake}
          balance={balance}
          cta="PLAY"
          onPress={find}
          disabled={!affordable || openRound !== null}
        />
      </Dock>
    </View>
  );
}
