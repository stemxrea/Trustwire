/**
 * DeviceRadar — scans for nearby BLE devices and mDNS services and renders
 * them on an animated radar display.
 *
 * ⚠️  Requires a Development Build (expo-dev-client). Neither react-native-ble-plx
 *     nor react-native-zeroconf work inside the standard Expo Go client because
 *     they depend on native code compiled at build time.
 *
 *     To run locally:
 *       npx expo run:ios   (or npx expo run:android)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import type { Device as BleDevice } from 'react-native-ble-plx';
import Zeroconf from 'react-native-zeroconf';
import type { Service as ZeroconfService } from 'react-native-zeroconf';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

// ─── Sizing ──────────────────────────────────────────────────────────────────

const SCREEN_WIDTH = Dimensions.get('window').width;
const RADAR_SIZE = SCREEN_WIDTH * 0.85;
const RADAR_RADIUS = RADAR_SIZE / 2;

// ─── Types ───────────────────────────────────────────────────────────────────

interface BleEntry {
  id: string;
  name: string | null;
  rssi: number;
}

interface MdnsEntry {
  name: string;
  host: string;
  port: number;
  fullName: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Maps an RSSI value (dBm) to a 0-1 distance ratio (0 = center, 1 = edge). */
function rssiToRatio(rssi: number): number {
  const clamped = Math.max(-100, Math.min(-30, rssi));
  return (clamped - -30) / (-100 - -30);
}

/** Returns (x, y) offsets from the radar centre for a given ratio and angle. */
function polarOffset(ratio: number, angleDeg: number) {
  const r = ratio * (RADAR_RADIUS - 20);
  const rad = (angleDeg * Math.PI) / 180;
  return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
}

/** Requests Android runtime permissions for Bluetooth + Location. */
async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  const perms = [
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ] as const;

  // Android 12+ needs BLUETOOTH_SCAN and BLUETOOTH_CONNECT
  const extra =
    parseInt(String(Platform.Version), 10) >= 31
      ? ([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ] as const)
      : [];

  const results = await PermissionsAndroid.requestMultiple([...perms, ...extra]);
  return Object.values(results).every(
    (r) => r === PermissionsAndroid.RESULTS.GRANTED,
  );
}

// ─── Animated radar ring ──────────────────────────────────────────────────────

function RadarRing({ delay }: { delay: number }) {
  const scale = useSharedValue(0.2);
  const opacity = useSharedValue(0.7);

  useEffect(() => {
    const duration = 2400;
    scale.value = withRepeat(
      withTiming(1, { duration, easing: Easing.out(Easing.ease) }),
      -1,
      false,
    );
    opacity.value = withRepeat(
      withTiming(0, { duration, easing: Easing.out(Easing.ease) }),
      -1,
      false,
    );

    // Offset start by delay frames using a tiny one-shot timer effect via JS
    const id = setTimeout(() => {
      scale.value = withRepeat(
        withTiming(1, { duration, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      );
      opacity.value = withRepeat(
        withTiming(0, { duration, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      );
    }, delay);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delay]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return <Animated.View style={[styles.radarRing, style]} />;
}

// ─── Main component ───────────────────────────────────────────────────────────

// How long each BLE sweep runs before restarting (ms)
const BLE_SWEEP_DURATION = 25_000;

export default function DeviceRadar() {
  const [bleDevices, setBleDevices] = useState<BleEntry[]>([]);
  const [mdnsServices, setMdnsServices] = useState<MdnsEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bleManager = useRef<BleManager | null>(null);
  const zeroconf = useRef<Zeroconf | null>(null);
  const bleSweepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);
  // Tracks whether we are actively scanning so runBleSweep can self-terminate.
  const isScanningRef = useRef(false);
  // Prevents registering duplicate zeroconf listeners across resume calls.
  const zeroconfListenersAttached = useRef(false);

  // Assign stable angle per device so dots don't jump around on re-render
  const angleMap = useRef<Map<string, number>>(new Map());
  function getAngle(id: string): number {
    if (!angleMap.current.has(id)) {
      angleMap.current.set(id, Math.random() * 360);
    }
    return angleMap.current.get(id)!;
  }

  /** Run one BLE sweep, then schedule the next sweep if still scanning. */
  const runBleSweep = useCallback(() => {
    if (!isMounted.current || !isScanningRef.current) return;

    bleManager.current?.stopDeviceScan();

    bleManager.current?.startDeviceScan(
      null,
      { allowDuplicates: true },
      (err, device: BleDevice | null) => {
        if (!isMounted.current) return;
        if (err) {
          if ((err as { errorCode?: number }).errorCode === 5) {
            setError('Bluetooth is powered off. Please enable it.');
          }
          return;
        }
        if (!device) return;

        setBleDevices((prev) => {
          const existing = prev.findIndex((d) => d.id === device.id);
          const entry: BleEntry = {
            id: device.id,
            name: device.name ?? device.localName ?? null,
            rssi: device.rssi ?? -100,
          };
          if (existing >= 0) {
            const next = [...prev];
            next[existing] = entry;
            return next;
          }
          return [...prev, entry];
        });
      },
    );

    // Schedule the next sweep only if still scanning
    bleSweepTimer.current = setTimeout(() => {
      if (isMounted.current && isScanningRef.current) runBleSweep();
    }, BLE_SWEEP_DURATION);
  }, []);

  const stopAll = useCallback(() => {
    isScanningRef.current = false;
    if (bleSweepTimer.current) {
      clearTimeout(bleSweepTimer.current);
      bleSweepTimer.current = null;
    }
    bleManager.current?.stopDeviceScan();
    zeroconf.current?.stop();
    setScanning(false);
  }, []);

  const startScan = useCallback(async () => {
    setError(null);

    const granted = await requestAndroidPermissions();
    if (!granted) {
      setError('Bluetooth and location permissions are required.');
      return;
    }

    isScanningRef.current = true;
    setScanning(true);

    // ── BLE scan (continuous sweeps) ─────────────────────────────────────────
    if (!bleManager.current) {
      bleManager.current = new BleManager();
    }
    runBleSweep();

    // ── mDNS scan ───────────────────────────────────────────────────────────
    if (!zeroconf.current) {
      zeroconf.current = new Zeroconf();
    }

    // Only register listeners once; stop/restart scanning without re-attaching.
    if (!zeroconfListenersAttached.current) {
      zeroconfListenersAttached.current = true;

      zeroconf.current.on('resolved', (service: ZeroconfService) => {
        if (!isMounted.current) return;
        setMdnsServices((prev) => {
          if (prev.some((s) => s.name === service.name)) return prev;
          return [
            ...prev,
            {
              name: service.name,
              host: service.host,
              port: service.port,
              fullName: service.fullName,
            },
          ];
        });
      });

      zeroconf.current.on('error', (err: Error) => {
        if (isMounted.current) {
          console.warn('[DeviceRadar] mDNS error:', err.message);
          setError(`mDNS error: ${err.message}`);
        }
      });
    } else {
      // Resume: restart any previously stopped scan
      zeroconf.current.stop();
    }

    const serviceTypes = ['_http', '_https', '_smb', '_afpovertcp', '_workstation'];
    for (const type of serviceTypes) {
      zeroconf.current.scan(type, 'tcp', 'local.');
    }
  }, [runBleSweep]);

  // Auto-start scanning on mount; clean up on unmount
  useEffect(() => {
    isMounted.current = true;
    startScan();
    return () => {
      isMounted.current = false;
      isScanningRef.current = false;
      if (bleSweepTimer.current) clearTimeout(bleSweepTimer.current);
      bleManager.current?.stopDeviceScan();
      bleManager.current?.destroy();
      zeroconf.current?.stop();
    };
  // Both callbacks are stable (useCallback with stable deps); run on mount only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <Text style={styles.appName}>Trustwire</Text>
      <Text style={styles.heading}>📡 Device Radar</Text>

      {/* Radar canvas */}
      <View style={styles.radarContainer}>
        {/* Concentric static rings */}
        {[0.33, 0.66, 1].map((scale) => (
          <View
            key={scale}
            style={[
              styles.staticRing,
              { width: RADAR_SIZE * scale, height: RADAR_SIZE * scale, borderRadius: (RADAR_SIZE * scale) / 2 },
            ]}
          />
        ))}

        {/* Crosshairs */}
        <View style={styles.crossH} />
        <View style={styles.crossV} />

        {/* Animated pulse rings */}
        <RadarRing delay={0} />
        <RadarRing delay={800} />
        <RadarRing delay={1600} />

        {/* BLE device dots */}
        {bleDevices.map((device) => {
          const ratio = rssiToRatio(device.rssi);
          const { x, y } = polarOffset(ratio, getAngle(device.id));
          return (
            <View
              key={device.id}
              style={[styles.dot, styles.dotBle, { left: RADAR_RADIUS + x - 6, top: RADAR_RADIUS + y - 6 }]}
            >
              <Text style={styles.dotLabel} numberOfLines={1}>
                {device.name ?? device.id.slice(-5)}
              </Text>
            </View>
          );
        })}

        {/* mDNS service dots */}
        {mdnsServices.map((svc, i) => {
          const ratio = 0.35;
          const angle = mdnsServices.length > 1
            ? (i / mdnsServices.length) * 360
            : 45;
          const { x, y } = polarOffset(ratio, angle);
          return (
            <View
              key={svc.name}
              style={[styles.dot, styles.dotMdns, { left: RADAR_RADIUS + x - 6, top: RADAR_RADIUS + y - 6 }]}
            >
              <Text style={styles.dotLabel} numberOfLines={1}>
                {svc.name}
              </Text>
            </View>
          );
        })}

        {/* Centre dot */}
        <View style={styles.centerDot} />

        {/* Scanning indicator */}
        {scanning && (
          <View style={styles.scanningBadge}>
            <Text style={styles.scanningText}>● LIVE</Text>
          </View>
        )}
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, styles.dotBle]} />
          <Text style={styles.legendText}>BLE ({bleDevices.length})</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, styles.dotMdns]} />
          <Text style={styles.legendText}>Wi-Fi ({mdnsServices.length})</Text>
        </View>
      </View>

      {/* Pause / Resume button */}
      <TouchableOpacity
        style={[styles.button, scanning && styles.buttonActive]}
        onPress={scanning ? stopAll : startScan}
        accessibilityRole="button"
        accessibilityLabel={scanning ? 'Pause scanning' : 'Resume scanning'}
      >
        <Text style={styles.buttonText}>{scanning ? '⏸ Pause' : '▶ Resume'}</Text>
      </TouchableOpacity>

      {error && <Text style={styles.errorText}>{error}</Text>}

      {/* Device list */}
      {(bleDevices.length > 0 || mdnsServices.length > 0) && (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {bleDevices.map((d) => (
            <View key={d.id} style={styles.listRow}>
              <View style={[styles.legendDot, styles.dotBle]} />
              <View style={styles.listInfo}>
                <Text style={styles.listName}>{d.name ?? 'Unknown'}</Text>
                <Text style={styles.listSub}>{d.id}</Text>
              </View>
              <Text style={styles.rssiText}>{d.rssi} dBm</Text>
            </View>
          ))}
          {mdnsServices.map((s) => (
            <View key={s.name} style={styles.listRow}>
              <View style={[styles.legendDot, styles.dotMdns]} />
              <View style={styles.listInfo}>
                <Text style={styles.listName}>{s.name}</Text>
                <Text style={styles.listSub}>{s.host}:{s.port} · {s.fullName}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const BRAND_DARK = '#0A1628';
const BRAND_BLUE = '#1A73E8';
const BRAND_GREEN = '#00C853';
const BRAND_ORANGE = '#FF6D00';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BRAND_DARK,
    alignItems: 'center',
    paddingTop: 52,
    paddingHorizontal: 16,
  },
  appName: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 2,
  },
  heading: {
    color: '#AAAAAA',
    fontSize: 15,
    fontWeight: '500',
    marginBottom: 12,
    letterSpacing: 0.5,
  },

  // ── Radar ──
  radarContainer: {
    width: RADAR_SIZE,
    height: RADAR_SIZE,
    borderRadius: RADAR_RADIUS,
    backgroundColor: 'rgba(26,115,232,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(26,115,232,0.3)',
  },
  staticRing: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(26,115,232,0.25)',
  },
  crossH: {
    position: 'absolute',
    width: RADAR_SIZE,
    height: 1,
    backgroundColor: 'rgba(26,115,232,0.2)',
  },
  crossV: {
    position: 'absolute',
    width: 1,
    height: RADAR_SIZE,
    backgroundColor: 'rgba(26,115,232,0.2)',
  },
  radarRing: {
    position: 'absolute',
    width: RADAR_SIZE,
    height: RADAR_SIZE,
    borderRadius: RADAR_RADIUS,
    borderWidth: 2,
    borderColor: 'rgba(26,115,232,0.6)',
  },
  centerDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: BRAND_BLUE,
    left: RADAR_RADIUS - 5,
    top: RADAR_RADIUS - 5,
  },
  scanningBadge: {
    position: 'absolute',
    bottom: 8,
    right: 12,
    backgroundColor: 'rgba(0,200,83,0.15)',
    borderRadius: 8,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  scanningText: {
    color: BRAND_GREEN,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  dot: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    alignItems: 'center',
  },
  dotBle: {
    backgroundColor: BRAND_GREEN,
  },
  dotMdns: {
    backgroundColor: BRAND_ORANGE,
  },
  dotLabel: {
    position: 'absolute',
    top: 14,
    color: '#FFFFFF',
    fontSize: 9,
    width: 60,
    textAlign: 'center',
    left: -24,
  },

  // ── Legend ──
  legend: {
    flexDirection: 'row',
    gap: 24,
    marginTop: 12,
    marginBottom: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendText: {
    color: '#AAAAAA',
    fontSize: 13,
  },

  // ── Button ──
  button: {
    backgroundColor: BRAND_BLUE,
    paddingVertical: 12,
    paddingHorizontal: 40,
    borderRadius: 24,
    marginBottom: 12,
  },
  buttonActive: {
    backgroundColor: '#7F2A2A',
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 15,
  },
  errorText: {
    color: '#FF8080',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
    paddingHorizontal: 8,
  },

  // ── List ──
  list: {
    width: '100%',
    maxHeight: 200,
  },
  listContent: {
    gap: 8,
    paddingBottom: 16,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#12243F',
    borderRadius: 10,
    padding: 10,
    gap: 10,
    borderWidth: 1,
    borderColor: '#1E3A5F',
  },
  listInfo: {
    flex: 1,
  },
  listName: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  listSub: {
    color: '#6A8FBF',
    fontSize: 11,
    marginTop: 2,
  },
  rssiText: {
    color: BRAND_GREEN,
    fontSize: 12,
    fontWeight: '600',
    minWidth: 60,
    textAlign: 'right',
  },
});
