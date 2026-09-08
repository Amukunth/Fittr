import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useDevices } from '../../hooks/useDevices';
import { relativeDay } from '../../lib/format';
import type { RootStackParamList } from '../../navigation/types';
import type { UserDeviceRow } from '../../types/database';
import { colors, space } from '../../theme/tokens';
import {
  Body,
  Button,
  Display,
  Dock,
  IconCircle,
  Label,
  Notice,
  RowGroup,
  SectionHead,
  SettingsRow,
  Skeleton,
  Tag,
  TopBar,
} from '../../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Sessions'>;

const SKELETON_ROWS = 3;

/** "Last active Today · v1.0.3". */
function activity(device: UserDeviceRow): string {
  const when = relativeDay(device.last_seen_at);
  const base = when ? `Last active ${when}` : 'Last active unknown';
  return device.app_version ? `${base} · v${device.app_version}` : base;
}

export function SessionsScreen({ navigation }: Props) {
  const { devices, thisDeviceId, loading, error, signingOut, signOutOthers } =
    useDevices();
  // Set after signOutOthers() settles; the hook reports failure through
  // `error`, so the success notice only renders when that is clear.
  const [signedOut, setSignedOut] = useState(false);

  const back = () =>
    navigation.canGoBack()
      ? navigation.goBack()
      : navigation.navigate('Settings');

  // This phone first; the hook already orders the rest by latest activity.
  const { ordered, others } = useMemo(() => {
    const mine = devices.filter(d => d.device_id === thisDeviceId);
    const rest = devices.filter(d => d.device_id !== thisDeviceId);
    return { ordered: [...mine, ...rest], others: rest };
  }, [devices, thisDeviceId]);

  const run = async () => {
    setSignedOut(false);
    // Never rejects: useDevices catches and surfaces failures as `error`.
    await signOutOthers();
    setSignedOut(true);
  };

  const confirmSignOut = () => {
    const count =
      others.length === 1 ? 'One other device' : `${others.length} other devices`;
    Alert.alert(
      'Sign out other devices?',
      `${count} will have to sign in again. This one stays signed in.`,
      [
        { text: 'Keep them', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            run();
          },
        },
      ],
    );
  };

  const showEmpty = !loading && !error && others.length === 0;

  return (
    <View style={styles.screen}>
      <TopBar
        left={
          <IconCircle icon="arrow-left" accessibilityLabel="Back" onPress={back} />
        }
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <Label size={11}>ACCOUNT & SECURITY</Label>
          <Display size={40} style={styles.title}>
            WHERE YOU'RE IN.
          </Display>
          <Body muted style={styles.lede}>
            Devices that have opened Fittr with your account. Signing out the
            others revokes their sessions on the server.
          </Body>
        </View>

        {error ? <Notice icon="warning">{error}</Notice> : null}
        {signedOut && !error ? (
          <Notice icon="check" iconColor={colors.accent}>
            Signed out everywhere else.
          </Notice>
        ) : null}

        <View>
          <SectionHead
            right={
              !loading && ordered.length > 0 ? (
                <Label>{`${ordered.length} SIGNED IN`}</Label>
              ) : null
            }
          >
            DEVICES
          </SectionHead>
          {loading ? (
            <RowGroup>
              {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <SkeletonRow key={i} />
              ))}
            </RowGroup>
          ) : ordered.length > 0 ? (
            <RowGroup>
              {ordered.map(device => {
                const current = device.device_id === thisDeviceId;
                return (
                  <SettingsRow
                    key={device.id}
                    icon="devices"
                    title={device.name}
                    subtitle={activity(device)}
                    right={
                      current ? <Tag label="THIS DEVICE" tone="accent" /> : undefined
                    }
                  />
                );
              })}
            </RowGroup>
          ) : null}
          {showEmpty ? (
            <Notice icon="devices" iconColor={colors.secondary} style={styles.empty}>
              No other devices yet.
            </Notice>
          ) : null}
        </View>
      </ScrollView>
      <Dock>
        <Button
          label="SIGN OUT ALL OTHER DEVICES"
          variant="secondary"
          onPress={confirmSignOut}
          loading={signingOut}
          disabled={loading || others.length === 0}
        />
      </Dock>
    </View>
  );
}

/** Placeholder row while the device list loads. */
function SkeletonRow() {
  return (
    <View style={styles.skeletonRow}>
      <Skeleton width={20} height={20} radius={10} />
      <View style={styles.skeletonText}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="40%" height={12} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingTop: space.md,
    paddingHorizontal: space.gutter,
    paddingBottom: space.xxxl,
    gap: space.xl,
  },
  title: { marginTop: space.sm },
  lede: { marginTop: space.md + 2 },
  empty: { marginTop: space.sm + 2 },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    minHeight: 56,
  },
  skeletonText: { flex: 1, gap: 6 },
});
