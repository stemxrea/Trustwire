import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import type { ExpoUpdatesManifest } from 'expo-manifests';

type UpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'upToDate'
  | 'error';

export default function App() {
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Check for OTA updates when the app loads
  useEffect(() => {
    if (!__DEV__) {
      checkForUpdate();
    }
  }, []);

  async function checkForUpdate() {
    try {
      setUpdateState('checking');
      setErrorMessage(null);

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
            {
              text: 'Restart',
              onPress: () => Updates.reloadAsync(),
            },
          ],
        );
      } else {
        setUpdateState('upToDate');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setErrorMessage(message);
      setUpdateState('error');
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
          <View style={[styles.badge, styles.badgeReady]}>
            <Text style={styles.badgeText}>✓ Update ready — restart to apply</Text>
          </View>
        );
      case 'upToDate':
        return (
          <View style={[styles.badge, styles.badgeGood]}>
            <Text style={styles.badgeText}>✓ App is up to date</Text>
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

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.logo}>Trustwire</Text>
        <Text style={styles.tagline}>Secure Over-The-Air Updates</Text>
      </View>

      {/* Update status */}
      <View style={styles.updateSection}>
        {renderUpdateBadge()}

        <TouchableOpacity
          style={[styles.button, updateState === 'checking' || updateState === 'downloading' ? styles.buttonDisabled : null]}
          onPress={checkForUpdate}
          disabled={updateState === 'checking' || updateState === 'downloading'}
          accessibilityLabel="Check for updates"
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Check for Updates</Text>
        </TouchableOpacity>

        {errorMessage && (
          <Text style={styles.errorDetail}>{errorMessage}</Text>
        )}
      </View>

      {/* Info cards */}
      <View style={styles.cards}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Version</Text>
          <Text style={styles.cardValue}>
            {(Updates.manifest as ExpoUpdatesManifest | null)?.runtimeVersion ?? '1.0.0'}
          </Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Platform</Text>
          <Text style={styles.cardValue}>{Platform.OS.toUpperCase()}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Channel</Text>
          <Text style={styles.cardValue}>
            {Updates.channel ?? 'development'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const BRAND_DARK = '#0A1628';
const BRAND_BLUE = '#1A73E8';
const BRAND_BLUE_LIGHT = '#4A9EFF';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BRAND_DARK,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 48,
  },
  logo: {
    fontSize: 42,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  tagline: {
    fontSize: 16,
    color: BRAND_BLUE_LIGHT,
    marginTop: 6,
    letterSpacing: 0.5,
  },
  updateSection: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 40,
    gap: 16,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
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
    fontSize: 14,
    fontWeight: '600',
  },
  button: {
    backgroundColor: BRAND_BLUE,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    width: '100%',
    shadowColor: BRAND_BLUE,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  errorDetail: {
    color: '#FF8080',
    fontSize: 13,
    textAlign: 'center',
  },
  cards: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  card: {
    flex: 1,
    backgroundColor: '#12243F',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1E3A5F',
  },
  cardTitle: {
    color: BRAND_BLUE_LIGHT,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  cardValue: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
