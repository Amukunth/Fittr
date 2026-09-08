import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import { fmtSigned, formatDateTime } from '../../lib/format';
import type { RootStackParamList } from '../../navigation/types';
import type { PointsLedgerEntryRow } from '../../types/database';
import { TRANSACTION_LABEL, UNIT } from '../../theme/copy';
import { Icon } from '../../theme/icons';
import { colors, space, typography } from '../../theme/tokens';
import {
  Body,
  Display,
  EmptyRing,
  IconCircle,
  Label,
  Loading,
  Notice,
  Numeral,
  TopBar,
} from '../../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Transactions'>;

/** Newest first; the ledger is append-only so 200 covers months of play. */
const PAGE = 200;

/**
 * The points ledger, newest first. RLS scopes points_ledger_entries to the
 * signed-in user, so no user filter is needed here. Every row is written by
 * the server at settlement (or by grant_starter_bonus) and never edited, so
 * there is no pending state to show: everything on the books is posted.
 */
export function TransactionsScreen({ navigation }: Props) {
  const [entries, setEntries] = useState<PointsLedgerEntryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const back = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Settings');

  const load = useCallback(async () => {
    const { data, error: queryError } = await supabase
      .from('points_ledger_entries')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(PAGE);
    if (queryError) {
      setError(queryError.message);
    } else {
      setError(null);
      setEntries((data ?? []) as PointsLedgerEntryRow[]);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    load();
  };

  const empty = entries.length === 0;
  const listStyle: ViewStyle = empty ? styles.listContentEmpty : styles.listContent;

  return (
    <View style={styles.screen}>
      <TopBar
        left={<IconCircle icon="arrow-left" accessibilityLabel="Back" onPress={back} />}
      />
      <View style={styles.head}>
        <Label size={11}>PAYMENT METHODS</Label>
        <Display size={40} style={styles.title}>
          HISTORY.
        </Display>
        {error ? (
          <Notice icon="warning" style={styles.notice}>
            {error}
          </Notice>
        ) : null}
      </View>
      {loading ? (
        <Loading />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <LedgerRow entry={item} />}
          contentContainerStyle={listStyle}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
              progressBackgroundColor={colors.raised}
            />
          }
          ListEmptyComponent={error ? undefined : <EmptyBooks />}
          ListFooterComponent={
            entries.length >= PAGE ? (
              <Text style={styles.footer}>Showing your last {PAGE} entries.</Text>
            ) : undefined
          }
        />
      )}
    </View>
  );
}

/** One ledger line: sign tile, what it was, when, and the signed amount. */
function LedgerRow({ entry }: { entry: PointsLedgerEntryRow }) {
  const credit = entry.amount > 0;
  const title = TRANSACTION_LABEL[entry.reason] ?? entry.reason;
  const when = formatDateTime(entry.created_at);
  const bout = entry.match_id ? ` · Bout ${entry.match_id.slice(0, 6)}` : '';
  const amount = fmtSigned(entry.amount);
  const tone = credit ? colors.accent : colors.secondary;
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`${title}, ${amount} ${UNIT}, ${when}${bout}, posted`}
    >
      <View style={[styles.tile, credit ? styles.tileCredit : styles.tileDebit]}>
        <Icon name={credit ? 'plus' : 'minus'} size={14} color={tone} />
      </View>
      <View style={styles.rowText}>
        <Text style={typography.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.when} numberOfLines={1}>
          {`${when}${bout}`}
        </Text>
      </View>
      <View style={styles.amount}>
        <View style={styles.amountRow}>
          <Numeral size={20} color={tone}>
            {amount}
          </Numeral>
          <Label size={9} color={colors.secondary} tracking={0.12}>
            {UNIT}
          </Label>
        </View>
        <Label size={9} tracking={0.12} style={styles.status}>
          POSTED
        </Label>
      </View>
    </View>
  );
}

function EmptyBooks() {
  return (
    <View style={styles.empty}>
      <EmptyRing />
      <Display size={36} style={styles.emptyHead}>
        {'NOTHING ON\nTHE BOOKS.'}
      </Display>
      <Body muted style={styles.emptyBody}>
        Bonus credits, wagers and wins all land here.
      </Body>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  head: {
    paddingTop: space.md,
    paddingHorizontal: space.gutter,
    gap: space.xl,
  },
  title: { marginTop: space.sm },
  notice: { marginTop: -space.sm },
  listContent: {
    paddingTop: space.sm,
    paddingHorizontal: space.gutter,
    paddingBottom: space.xxxl,
  },
  listContentEmpty: {
    flexGrow: 1,
    paddingHorizontal: space.gutter,
    paddingBottom: space.xxxl,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  tile: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileCredit: { backgroundColor: colors.accentTint },
  tileDebit: { backgroundColor: colors.raised },
  rowText: { flex: 1, minWidth: 0 },
  when: { ...typography.footnote, marginTop: 2 },
  amount: { alignItems: 'flex-end' },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.xs,
  },
  status: { marginTop: 2 },
  footer: {
    ...typography.footnote,
    textAlign: 'center',
    paddingVertical: space.lg,
  },

  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: space.xs,
    paddingBottom: 40,
  },
  emptyHead: { marginTop: 28 },
  emptyBody: { marginTop: space.md },
});
