import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { UserIdentity } from '@supabase/supabase-js';
import { useAuth } from '../../context/AuthContext';
import { relativeDay } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import type { RootStackParamList } from '../../navigation/types';
import { colors, space } from '../../theme/tokens';
import {
  Body,
  Button,
  Display,
  IconCircle,
  Label,
  Notice,
  RowGroup,
  SectionHead,
  SettingsRow,
  TopBar,
} from '../../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'ConnectedAccounts'>;

/** 'apple' -> "Apple", 'linkedin_oidc' -> "Linkedin oidc". */
function providerLabel(provider: string): string {
  const words = provider.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

/** The address Supabase stored on the identity, if it is a string. */
function identityEmail(identity: UserIdentity): string | null {
  const value = identity.identity_data?.email;
  return typeof value === 'string' && value ? value : null;
}

export function ConnectedAccountsScreen({ navigation }: Props) {
  const { session, refreshSession } = useAuth();
  /** identity_id of the row being unlinked, so only its button spins. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Provider label of the identity that was just removed. */
  const [unlinked, setUnlinked] = useState<string | null>(null);

  const back = () =>
    navigation.canGoBack()
      ? navigation.goBack()
      : navigation.navigate('Settings');

  const identities = session?.user.identities ?? [];
  const emailIdentities = identities.filter(i => i.provider === 'email');
  const social = identities.filter(i => i.provider !== 'email');
  const ordered = [...emailIdentities, ...social];

  const unlink = async (identity: UserIdentity) => {
    const name = providerLabel(identity.provider);
    setError(null);
    setUnlinked(null);
    setBusyId(identity.identity_id);
    try {
      // Supabase refuses to remove the last identity on an account and
      // says so in the message; that is shown as-is rather than reworded.
      const { error: unlinkError } = await supabase.auth.unlinkIdentity(identity);
      if (unlinkError) {
        setError(unlinkError.message);
        return;
      }
      await refreshSession();
      setUnlinked(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const confirmUnlink = (identity: UserIdentity) => {
    const name = providerLabel(identity.provider);
    Alert.alert(
      `Unlink ${name}?`,
      `You won't be able to sign in with ${name} until you link it again.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Unlink',
          style: 'destructive',
          onPress: () => {
            unlink(identity);
          },
        },
      ],
    );
  };

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
            CONNECTED.
          </Display>
          <Body muted style={styles.lede}>
            Every way you can sign in to this account.
          </Body>
        </View>

        {error ? <Notice icon="warning">{error}</Notice> : null}
        {unlinked && !error ? (
          <Notice icon="check" iconColor={colors.accent}>
            {`${unlinked} unlinked.`}
          </Notice>
        ) : null}

        <View>
          <SectionHead>SIGN-IN METHODS</SectionHead>
          {ordered.length > 0 ? (
            <RowGroup>
              {ordered.map(identity => {
                const key = identity.identity_id;
                if (identity.provider === 'email') {
                  return (
                    <SettingsRow
                      key={key}
                      icon="mail"
                      title="Email"
                      subtitle={session?.user.email ?? identityEmail(identity) ?? undefined}
                      value="Linked"
                    />
                  );
                }
                const when = identity.created_at ? relativeDay(identity.created_at) : '';
                return (
                  <SettingsRow
                    key={key}
                    icon="link"
                    title={providerLabel(identity.provider)}
                    subtitle={when ? `Linked ${when}` : 'Linked'}
                    right={
                      <Button
                        label="UNLINK"
                        variant="outline"
                        size="sm"
                        onPress={() => confirmUnlink(identity)}
                        loading={busyId === key}
                        disabled={busyId !== null && busyId !== key}
                      />
                    }
                  />
                );
              })}
            </RowGroup>
          ) : null}
          {social.length === 0 ? (
            <Notice icon="link" iconColor={colors.secondary} style={styles.empty}>
              No social accounts linked. Sign in with Apple and Google arrive
              once those providers are configured for Fittr; until then, email
              is the only way in.
            </Notice>
          ) : null}
        </View>
      </ScrollView>
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
});
