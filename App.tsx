import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import DeviceRadar from './components/DeviceRadar';

type UpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'upToDate'
  | 'error';

export default function App() {
  const [updateState, setUpdateState] = useState<UpdateState>('idle');

  // Check for OTA updates when the app loads
  useEffect(() => {
    if (!__DEV__) {
      checkForUpdate();
    }
  }, []);

  async function checkForUpdate() {
    try {
      setUpdateState('checking');
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setUpdateState('downloading');
        await Updates.fetchUpdateAsync();
        setUpdateState('ready');
        Alert.alert(
          'Update Ready',
          'A new version of Trustwire has been downloaded. Restart now to apply it.',
          [
            { text: 'Later', style: 'cancel', onPress: () => setUpdateState('idle') },
            { text: 'Restart', onPress: () => Updates.reloadAsync() },
          ],
        );
      } else {
        setUpdateState('upToDate');
        setTimeout(() => setUpdateState('idle'), 3000);
      }
    } catch {
      setUpdateState('error');
      setTimeout(() => setUpdateState('idle'), 4000);
    }
  }

  function renderUpdateBadge() {
    switch (updateState) {
      case 'checking':
        return (
          <View style={[styles.badge, styles.badgeChecking]}>
            <ActivityIndicator size="small" color="#fff" style={styles.badgeIcon} />
            <Text style={styles.badgeText}>Checking for updates…</Text>
          </View>
        );
      case 'downloading':
        return (
          <View style={[styles.badge, styles.badgeChecking]}>
            <ActivityIndicator size="small" color="#fff" style={styles.badgeIcon} />
            <Text style={styles.badgeText}>Downloading update…</Text>
          </View>
        );
      case 'ready':
        return (
          <TouchableOpacity
            style={[styles.badge, styles.badgeReady]}
            onPress={() => Updates.reloadAsync()}
            accessibilityRole="button"
            accessibilityLabel="Restart to apply update"
          >
            <Text style={styles.badgeText}>✓ Update ready — tap to restart</Text>
          </TouchableOpacity>
        );
      case 'upToDate':
        return (
          <View style={[styles.badge, styles.badgeGood]}>
            <Text style={styles.badgeText}>✓ Up to date</Text>
          </View>
        );
      case 'error':
        return (
          <View style={[styles.badge, styles.badgeError]}>
            <Text style={styles.badgeText}>⚠ Update check failed</Text>
          </View>
        );
      default:
        return null;
    }
  }

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {/* Floating OTA badge */}
      {updateState !== 'idle' && (
        <View style={styles.badgeContainer} pointerEvents="box-none">
          {renderUpdateBadge()}
        </View>
      )}

      {/* Radar fills the entire screen */}
      <DeviceRadar />
    </View>
  );
}

const BRAND_DARK = '#0A1628';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BRAND_DARK,
  },
  badgeContainer: {
    position: 'absolute',
    top: 52,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 20,
    gap: 8,
  },
  badgeChecking: {
    backgroundColor: '#2A4A7F',
  },
  badgeReady: {
    backgroundColor: '#1E5F3A',
  },
  badgeGood: {
    backgroundColor: '#1E5F3A',
  },
  badgeError: {
    backgroundColor: '#7F2A2A',
  },
  badgeIcon: {
    marginRight: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});
