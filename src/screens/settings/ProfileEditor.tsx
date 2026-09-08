import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AlertButton,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { useAuth } from '../../context/AuthContext';
import {
  pickAvatar,
  removeAvatarFiles,
  uploadAvatar,
  type AvatarSource,
} from '../../lib/avatar';
import { initialsOf } from '../../lib/identity';
import {
  DISPLAY_NAME_MAX,
  displayNameProblem,
  humanizeProfileError,
  normalizeUsername,
  profileHandle,
  updateMyProfile,
  usernameAvailable,
  usernameProblem,
} from '../../lib/profile';
import type { FitnessProfileRow } from '../../types/database';
import { Icon } from '../../theme/icons';
import { colors, fonts, radius, sizes, space, typography } from '../../theme/tokens';
import {
  Avatar,
  Button,
  Card,
  Divider,
  Input,
  Label,
  Notice,
  Numeral,
  TierPill,
} from '../../theme/ui';

const AVATAR_SIZE = 72;
const USERNAME_MAX = 20;
const AVAILABILITY_DEBOUNCE_MS = 400;
const SAVED_FLASH_MS = 3000;
const USERNAME_HELP = 'Letters, numbers, dots, underscores. 3–20.';

type Availability =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken' }
  | { kind: 'error'; message: string };

interface Baseline {
  name: string;
  user: string;
}

function errorText(e: unknown): string {
  return humanizeProfileError(e instanceof Error ? e.message : String(e));
}

/**
 * The PROFILE card on Settings: photo, display name, username, and the
 * read-only league / crowns line. Identity writes go through
 * update_my_profile(); the tier is changed on the Profile screen, not here.
 */
export function ProfileEditor({
  profile,
  fallbackHandle,
  wins,
  onChanged,
}: {
  profile: FitnessProfileRow;
  /** '@handle' from the auth user, used until the profile has a username. */
  fallbackHandle: string;
  /** Verified wins, or null while the record is still loading. */
  wins: number | null;
  /** Fired after any successful write so the owner can refetch the row. */
  onChanged: () => void;
}) {
  const { refreshSession } = useAuth();
  const userId = profile.user_id;
  const handle = profileHandle(profile, fallbackHandle);

  // ── Fields ────────────────────────────────────────────────────────────
  const profileName = profile.display_name ?? '';
  const profileUser = profile.username ?? normalizeUsername(fallbackHandle);

  const baseRef = useRef<Baseline>({ name: profileName, user: profileUser });
  const [base, setBase] = useState<Baseline>(baseRef.current);
  const [displayName, setDisplayName] = useState(profileName);
  const [username, setUsername] = useState(profileUser);

  // The row can move underneath us (realtime, another device). Fields the
  // user has not touched follow it; anything mid-edit is left alone.
  useEffect(() => {
    const prev = baseRef.current;
    if (prev.name === profileName && prev.user === profileUser) {
      return;
    }
    setDisplayName(cur => (cur === prev.name ? profileName : cur));
    setUsername(cur => (cur === prev.user ? profileUser : cur));
    baseRef.current = { name: profileName, user: profileUser };
    setBase(baseRef.current);
  }, [profileName, profileUser]);

  const trimmedName = displayName.trim();
  const normalizedUser = normalizeUsername(username);
  const nameChanged = trimmedName !== base.name;
  const userChanged = normalizedUser !== base.user;
  const nameProblem = displayNameProblem(displayName);
  const userProblem = userChanged ? usernameProblem(username) : null;

  // ── Username availability ─────────────────────────────────────────────
  const [availability, setAvailability] = useState<Availability>({ kind: 'idle' });

  useEffect(() => {
    if (!userChanged || userProblem) {
      setAvailability({ kind: 'idle' });
      return;
    }
    setAvailability({ kind: 'checking' });
    let active = true;
    const timer = setTimeout(() => {
      usernameAvailable(normalizedUser)
        .then(free => {
          if (active) {
            setAvailability({ kind: free ? 'available' : 'taken' });
          }
        })
        .catch((e: unknown) => {
          if (active) {
            setAvailability({ kind: 'error', message: errorText(e) });
          }
        });
    }, AVAILABILITY_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [normalizedUser, userChanged, userProblem]);

  let hintText = USERNAME_HELP;
  let hintStyle: StyleProp<TextStyle> = styles.hintDim;
  if (userProblem) {
    hintText = userProblem;
    hintStyle = styles.hintProblem;
  } else if (availability.kind === 'checking') {
    hintText = 'Checking…';
  } else if (availability.kind === 'available') {
    hintText = 'Available';
    hintStyle = styles.hintOk;
  } else if (availability.kind === 'taken') {
    hintText = 'Taken';
    hintStyle = styles.hintProblem;
  } else if (availability.kind === 'error') {
    hintText = availability.message;
    hintStyle = styles.hintProblem;
  }

  // ── Save ──────────────────────────────────────────────────────────────
  const canSave =
    (nameChanged || userChanged) &&
    !nameProblem &&
    !userProblem &&
    (!userChanged || availability.kind === 'available');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) {
      return;
    }
    const timer = setTimeout(() => setSaved(false), SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const save = async () => {
    if (!canSave || saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const row = await updateMyProfile({
        displayName: nameChanged ? trimmedName : undefined,
        username: userChanged ? normalizedUser : undefined,
      });
      // ownHandle() reads the auth metadata copy; pull the fresh user.
      await refreshSession();
      const next: Baseline = {
        name: row.display_name ?? '',
        user: row.username ?? baseRef.current.user,
      };
      baseRef.current = next;
      setBase(next);
      setDisplayName(next.name);
      setUsername(next.user);
      setSaved(true);
      onChanged();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Photo ─────────────────────────────────────────────────────────────
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const pick = useCallback(
    async (source: AvatarSource) => {
      setAvatarError(null);
      try {
        const picked = await pickAvatar(source);
        if (!picked) {
          return;
        }
        setUploading(true);
        const url = await uploadAvatar(userId, picked);
        await updateMyProfile({ avatarUrl: url });
        onChanged();
      } catch (e) {
        setAvatarError(errorText(e));
      } finally {
        setUploading(false);
      }
    },
    [userId, onChanged],
  );

  const remove = useCallback(async () => {
    setAvatarError(null);
    setUploading(true);
    try {
      await updateMyProfile({ avatarUrl: '' });
      await removeAvatarFiles(userId);
      onChanged();
    } catch (e) {
      setAvatarError(errorText(e));
    } finally {
      setUploading(false);
    }
  }, [userId, onChanged]);

  const changePhoto = () => {
    const hasPhoto = Boolean(profile.avatar_url);
    const buttons: AlertButton[] = [
      {
        text: 'Take photo',
        onPress: () => {
          pick('camera');
        },
      },
      {
        text: 'Choose from library',
        onPress: () => {
          pick('library');
        },
      },
    ];
    if (hasPhoto) {
      buttons.push({
        text: 'Remove photo',
        style: 'destructive',
        onPress: () => {
          remove();
        },
      });
    }
    // Android alerts hold three buttons; there, tapping outside cancels.
    if (Platform.OS === 'ios' || buttons.length < 3) {
      buttons.push({ text: 'Cancel', style: 'cancel' });
    }
    Alert.alert(
      'Profile photo',
      'Shown on your card and to your opponents.',
      buttons,
      { cancelable: true },
    );
  };

  return (
    <Card>
      <Pressable
        onPress={changePhoto}
        disabled={uploading}
        accessibilityRole="button"
        accessibilityLabel="Change photo"
        accessibilityState={{ busy: uploading, disabled: uploading }}
        style={({ pressed }) => [styles.photo, pressed && styles.pressed]}
      >
        <View style={styles.avatarBox}>
          <Avatar
            initials={initialsOf(handle)}
            uri={profile.avatar_url}
            size={AVATAR_SIZE}
            tone="accent"
          />
          {uploading ? (
            <View style={styles.avatarBusy}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : null}
        </View>
        <Label size={11} color={colors.accent}>
          CHANGE PHOTO
        </Label>
      </Pressable>
      {avatarError ? (
        <Notice icon="warning" style={styles.note}>
          {avatarError}
        </Notice>
      ) : null}

      <View style={styles.field}>
        <Label>DISPLAY NAME</Label>
        <Input
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={DISPLAY_NAME_MAX}
          placeholder="How you want to be known"
          autoCapitalize="words"
          returnKeyType="next"
          accessibilityLabel="Display name"
        />
        {nameProblem ? <Text style={styles.hintProblem}>{nameProblem}</Text> : null}
      </View>

      <View style={styles.field}>
        <Label>USERNAME</Label>
        <View style={styles.usernameField}>
          <Text style={styles.at}>@</Text>
          <Input
            style={styles.usernameInput}
            value={username}
            onChangeText={setUsername}
            maxLength={USERNAME_MAX}
            placeholder="username"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="done"
            accessibilityLabel="Username"
          />
        </View>
        <Text style={hintStyle}>{hintText}</Text>
      </View>

      {saveError ? (
        <Notice icon="warning" style={styles.note}>
          {saveError}
        </Notice>
      ) : null}
      {saved ? (
        <Notice icon="check" iconColor={colors.accent} style={styles.note}>
          Saved.
        </Notice>
      ) : null}
      <Button
        label="SAVE CHANGES"
        size="md"
        onPress={save}
        disabled={!canSave}
        loading={saving}
        style={styles.save}
      />

      <Divider />

      <View style={styles.standing}>
        <View style={styles.standingCell}>
          <Label>LEAGUE</Label>
          <TierPill tier={profile.strength_tier} style={styles.standingValue} />
        </View>
        <View style={styles.standingCell}>
          <Label>CROWNS</Label>
          <View style={[styles.crowns, styles.standingValue]}>
            <Icon name="crown" size={16} color={colors.accent} />
            <Numeral size={22}>{wins === null ? '—' : String(wins)}</Numeral>
          </View>
        </View>
      </View>
      <Text style={styles.footnote}>Crowns are verified bouts you have won.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  photo: { alignItems: 'center', gap: space.sm + 2, marginBottom: space.xs },
  pressed: { opacity: 0.7 },
  avatarBox: { width: AVATAR_SIZE, height: AVATAR_SIZE },
  avatarBusy: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },

  note: { marginTop: space.md },
  field: { gap: space.sm, marginTop: space.md },
  usernameField: {
    flexDirection: 'row',
    alignItems: 'center',
    height: sizes.input,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingLeft: space.cardPad,
  },
  at: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: colors.secondary,
    includeFontPadding: false,
  },
  usernameInput: {
    flex: 1,
    height: '100%',
    borderWidth: 0,
    backgroundColor: 'transparent',
    paddingLeft: 2,
  },
  hintDim: { ...typography.helper, paddingHorizontal: space.xs },
  hintOk: { ...typography.helper, color: colors.accent, paddingHorizontal: space.xs },
  hintProblem: { ...typography.helper, color: colors.text, paddingHorizontal: space.xs },

  save: { alignSelf: 'flex-start', marginTop: space.lg, marginBottom: space.cardPad },

  standing: { flexDirection: 'row', gap: space.sm, marginTop: space.cardPad },
  standingCell: { flex: 1 },
  standingValue: { marginTop: space.sm },
  crowns: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  footnote: { ...typography.footnote, marginTop: space.sm + 2 },
});
