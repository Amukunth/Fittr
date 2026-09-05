import React, { useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import { markOnboarded } from '../lib/onboarding';
import { fmtPoints } from '../lib/format';
import type { RootStackParamList } from '../navigation/types';
import { STARTER_PURSE, UNIT_LONG } from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, label, radius, space } from '../theme/tokens';
import { Body, Button, Card, Display, Label, Numeral, Small } from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

type Step = 1 | 2 | 3;

const STEPS_COPY = [
  {
    n: '01',
    title: 'PICK A STAKE',
    body: "Post a bout or take one that's open. You get matched at your level.",
  },
  {
    n: '02',
    title: 'COMPETE ON CAMERA',
    body: "Every rep is counted and verified live. Partial reps don't count.",
  },
  {
    n: '03',
    title: 'TAKE THE POT',
    body: 'Settled the second verification clears. No disputes.',
  },
];

/**
 * Three beats after sign-up: how a bout works, the camera is the ref, the
 * opening purse. Reading the profile here is what creates it (and grants the
 * starter bonus) so step three can print the real number.
 */
export function OnboardingScreen({ navigation }: Props) {
  const { session } = useAuth();
  const { profile } = useFitnessProfile();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>(1);
  const [asking, setAsking] = useState(false);

  const finish = async () => {
    if (session) {
      await markOnboarded(session.user.id);
    }
    navigation.replace('Home');
  };

  const requestCamera = async () => {
    // Android needs an explicit runtime request. iOS has no core RN API for
    // this: the native camera view raises the system prompt itself the
    // first time it mounts, backed by NSCameraUsageDescription.
    if (Platform.OS !== 'android') {
      return;
    }
    setAsking(true);
    try {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
        title: 'Camera access',
        message: 'Fittr needs the camera to count and verify your reps.',
        buttonPositive: 'Allow',
      });
    } finally {
      setAsking(false);
    }
  };

  const next = async () => {
    if (step === 1) {
      setStep(2);
    } else if (step === 2) {
      await requestCamera();
      setStep(3);
    } else {
      await finish();
    }
  };

  const purse = profile?.points_balance ?? STARTER_PURSE;
  const pad = {
    paddingTop: insets.top + space.xxxl + space.sm,
    paddingBottom: Math.max(insets.bottom, space.lg) + space.xxl,
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, pad]}
      bounces={false}
    >
      <View style={styles.progress}>
        <View style={styles.dots}>
          {([1, 2, 3] as Step[]).map(i => (
            <View
              key={i}
              style={[
                styles.dot,
                i === step && styles.dotCurrent,
                i <= step && styles.dotDone,
              ]}
            />
          ))}
        </View>
        <Pressable onPress={finish} hitSlop={10} accessibilityRole="button">
          <Text style={styles.skip}>SKIP</Text>
        </Pressable>
      </View>

      {step === 1 ? (
        <>
          <Label size={11} style={styles.kicker}>
            HOW A BOUT WORKS
          </Label>
          <Display size={48} style={styles.head}>
            THREE STEPS.{'\n'}ONE WINNER.
          </Display>
          <View style={styles.steps}>
            {STEPS_COPY.map(s => (
              <Card key={s.n} style={styles.stepCard}>
                <Numeral size={30} color={colors.accent} style={styles.stepNumber}>
                  {s.n}
                </Numeral>
                <View style={styles.stepText}>
                  <Display size={20}>{s.title}</Display>
                  <Small style={styles.stepBody}>{s.body}</Small>
                </View>
              </Card>
            ))}
          </View>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Label size={11} style={styles.kicker}>
            CAMERA ACCESS
          </Label>
          <Display size={48} style={styles.head}>
            THE CAMERA{'\n'}IS THE REF.
          </Display>
          <View style={styles.frame}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
            <Icon name="camera" size={56} color={colors.dim} />
          </View>
          <Body muted style={styles.frameNote}>
            Pose estimation runs on your phone. It counts reps, checks form and
            kills pre-recorded video. Nothing is uploaded until the bout ends.
          </Body>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Label size={11} style={styles.kicker}>
            OPENING PURSE
          </Label>
          <Display size={48} style={styles.head}>
            ON THE HOUSE.
          </Display>
          <View style={styles.purse}>
            <Numeral size={148} color={colors.accent}>
              {fmtPoints(purse)}
            </Numeral>
            <Text style={styles.purseUnit}>{UNIT_LONG} TO OPEN WITH</Text>
          </View>
          <Body muted>
            Stake them on bouts from 50 up. Win and they stack. Lose and
            somebody else stacks them.
          </Body>
        </>
      ) : null}

      <View style={styles.spacer} />

      <Button
        label={step === 1 ? 'NEXT' : step === 2 ? 'ALLOW CAMERA' : 'FIND A BOUT'}
        onPress={next}
        loading={asking}
      />
      {step === 2 ? (
        <Pressable
          onPress={() => setStep(3)}
          style={styles.notNow}
          accessibilityRole="button"
        >
          <Text style={styles.notNowText}>Not now</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, paddingHorizontal: space.xxl },
  progress: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 12, height: 4, borderRadius: 2, backgroundColor: colors.slot },
  dotCurrent: { width: 28 },
  dotDone: { backgroundColor: colors.accent },
  skip: { ...label(12, colors.dim, 0.1) },
  kicker: { marginTop: 36 },
  head: { marginTop: space.sm + 2 },
  steps: { marginTop: 36, gap: 14 },
  stepCard: { flexDirection: 'row', gap: space.lg },
  stepNumber: { minWidth: 40 },
  stepText: { flex: 1 },
  stepBody: { marginTop: 6 },
  frame: {
    marginTop: 28,
    height: 220,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: colors.accent,
  },
  cornerTL: { top: 14, left: 14, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 6 },
  cornerTR: { top: 14, right: 14, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 6 },
  cornerBL: { bottom: 14, left: 14, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 6 },
  cornerBR: { bottom: 14, right: 14, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 6 },
  frameNote: { marginTop: space.xl },
  purse: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingVertical: space.xxl,
  },
  purseUnit: { ...label(13, colors.secondary, 0.24), marginTop: space.sm },
  spacer: { flex: 1, minHeight: space.xxl },
  notNow: { marginTop: space.sm + 2, padding: space.md, alignItems: 'center' },
  notNowText: { ...label(13, colors.secondary, 0), textTransform: 'none' },
});
