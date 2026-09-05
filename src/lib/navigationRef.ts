import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/types';

/**
 * Navigation handle usable from outside a screen.
 *
 * MatchFoundWatcher subscribes to Realtime above the navigator — it has no
 * `navigation` prop of its own, because the whole point is that it fires
 * wherever the creator happens to be. Always guard on isReady(): events can
 * land before the container mounts, or after it unmounts on sign-out.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
