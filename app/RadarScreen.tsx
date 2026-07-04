import React, { useMemo, useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { Magnetometer } from 'expo-sensors';
import { RadiusBar } from './radiusbar';

type DevicePoint = {
  id: string;
  name: string;
  distanceM: number;
  angleDeg: number;
  type: 'BLE' | 'WIFI';
  rawDevice?: any;
};

type RadarScreenProps = {
  devices: DevicePoint[];
  headingDeg?: number | null;
  onSelectDevice?: (device: any) => void;
  isScanning?: boolean;
  onToggleScan?: () => void;
  statusText?: string;
  focusLabel?: string;
  onNavigateTargets?: () => void;
  onNavigateDiagnostics?: () => void;
  onNavigatePorts?: () => void;
  onNavigateOta?: () => void;
};

const RADAR_SIZE = 260;
const RADAR_CENTER = RADAR_SIZE / 2;
const SHIELD_SIZE = 36;
const RADIUS_CONFIDENCE_BUFFER_M = 1.5;

export default function RadarScreen({
  devices,
  headingDeg,
  onSelectDevice,
  isScanning = false,
  onToggleScan,
  statusText = 'Scanner Standby',
  focusLabel = 'ALL',
  onNavigateTargets,
  onNavigateDiagnostics,
  onNavigatePorts,
  onNavigateOta,
}: RadarScreenProps) {
  const [radiusM, setRadiusM] = useState(25);
  const [compassHeading, setCompassHeading] = useState(0);
  const [cardinalDirection, setCardinalDirection] = useState('N');

  useEffect(() => {
    Magnetometer.setUpdateInterval(32);
    const subscription = Magnetometer.addListener((data) => {
      const { x, y } = data;
      let angle = Math.atan2(y, x) * (180 / Math.PI);
      let heading = Math.round(angle);
      if (heading < 0) heading += 360;

      setCompassHeading(heading);

      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'];
      const index = Math.round((heading % 360) / 45);
      setCardinalDirection(dirs[index]);
    });

    return () => subscription.remove();
  }, []);

  const bleDevices = useMemo(() => devices.filter((d) => d.type === 'BLE'), [devices]);
  const wifiDevices = useMemo(() => devices.filter((d) => d.type === 'WIFI'), [devices]);
  const visible = useMemo(
    () =>
      devices.filter((d) => {
        const distance = Number.isFinite(d.distanceM) && d.distanceM >= 0 ? d.distanceM : Number.POSITIVE_INFINITY;
        return distance <= radiusM + RADIUS_CONFIDENCE_BUFFER_M;
      }),
    [devices, radiusM],
  );

  const effectiveHeading = typeof headingDeg === 'number' && Number.isFinite(headingDeg) ? headingDeg : compassHeading;
  const effectiveDirection =
    typeof headingDeg === 'number' && Number.isFinite(headingDeg)
      ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'][Math.round((((headingDeg % 360) + 360) % 360) / 45)]
      : cardinalDirection;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <View style={styles.logoRow}>
            <Text style={styles.logoShield}>🛡️</Text>
            <View>
              <Text style={styles.headerTitle}>TRUSTWIRE</Text>
              <Text style={styles.headerSubtitle}>DUAL SCANNER</Text>
            </View>
          </View>
          <View style={styles.statusRow}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>{statusText}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.runRadarBtn} onPress={onToggleScan}>
          <Text style={styles.runRadarText}>{isScanning ? '🎯 HALT ENGINE' : '🎯 RUN RADAR'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.gridRow}>
        <View style={styles.configCard}>
          <Text style={styles.cardLabel}>RADIUS</Text>
          <Text style={styles.cardValueMain}>{Math.round(radiusM)}m</Text>
          <Text style={styles.cardDesc}>Detection Range</Text>
        </View>
        <View style={styles.configCard}>
          <Text style={styles.cardLabel}>FOCUS</Text>
          <Text style={styles.cardValueMain}>{focusLabel}</Text>
          <Text style={styles.cardDesc}>Device Focus</Text>
        </View>
      </View>

      <View style={styles.radarOuterContainer}>
        <Text style={[styles.cardinalText, { top: -22, left: RADAR_CENTER - 6 }]}>N</Text>
        <Text style={[styles.cardinalText, { bottom: -22, left: RADAR_CENTER - 5 }]}>S</Text>
        <Text style={[styles.cardinalText, { left: -20, top: RADAR_CENTER - 8 }]}>W</Text>
        <Text style={[styles.cardinalText, { right: -20, top: RADAR_CENTER - 8 }]}>E</Text>

        <View style={[styles.radar, { transform: [{ rotate: `${-compassHeading}deg` }] }]}>
          <View style={[styles.radarRing, { width: RADAR_SIZE * 0.25, height: RADAR_SIZE * 0.25, borderRadius: (RADAR_SIZE * 0.25) / 2 }]} />
          <View style={[styles.radarRing, { width: RADAR_SIZE * 0.5, height: RADAR_SIZE * 0.5, borderRadius: (RADAR_SIZE * 0.5) / 2 }]} />
          <View style={[styles.radarRing, { width: RADAR_SIZE * 0.75, height: RADAR_SIZE * 0.75, borderRadius: (RADAR_SIZE * 0.75) / 2 }]} />
          <View style={[styles.radarRing, { width: RADAR_SIZE, height: RADAR_SIZE, borderRadius: RADAR_SIZE / 2 }]} />
          <View style={styles.crossH} />
          <View style={styles.crossV} />

          {visible.map((d) => {
            const angle = ((d.angleDeg - 90) * Math.PI) / 180;
            const r = (d.distanceM / radiusM) * (RADAR_CENTER - 16);
            const x = Math.cos(angle) * r;
            const y = Math.sin(angle) * r;
            return (
              <View
                key={d.id}
                style={[
                  styles.dot,
                  d.type === 'BLE' ? styles.dotBle : styles.dotWifi,
                  { left: RADAR_CENTER + x - 4, top: RADAR_CENTER + y - 4 },
                ]}
              />
            );
          })}
        </View>

        <View style={styles.centerShieldOutter} pointerEvents="none">
          <View style={styles.centerShieldOuterTip} />
          <View style={styles.centerShieldInner}>
            <View style={styles.centerShieldInnerTip} />
            <View style={styles.centerShieldGlyphWrap}>
              <View style={styles.tTopBar} />
              <View style={styles.tStem} />
              <View style={styles.tWingLeft} />
              <View style={styles.tWingRight} />
            </View>
          </View>
        </View>
      </View>

      <RadiusBar value={radiusM} onChange={setRadiusM} min={1} max={100} />

      <View style={styles.counterBoxContainer}>
        <View style={[styles.counterSection, styles.borderRight]}>
          <View style={styles.titleRow}>
            <View style={[styles.indicatorDot, { backgroundColor: '#00C9FF' }]} />
            <Text style={styles.counterTitle}>BLE Radio (Blue)</Text>
          </View>
          <Text style={styles.counterValue}>{bleDevices.length}</Text>
        </View>
        <View style={styles.counterSection}>
          <View style={styles.titleRow}>
            <View style={[styles.indicatorDot, { backgroundColor: '#00FF7A' }]} />
            <Text style={styles.counterTitle}>Wi-Fi LAN (Green)</Text>
          </View>
          <Text style={styles.counterValue}>{wifiDevices.length}</Text>
        </View>
      </View>

      <View style={styles.gridRow}>
        <View style={styles.configCard}>
          <Text style={styles.cardLabel}>TARGETS VISIBLE</Text>
          <View style={styles.metricDetailRow}>
            <Text style={styles.metricValueLarge}>{visible.length} / {devices.length}</Text>
            <Text style={styles.metricEmoji}>📊</Text>
          </View>
        </View>
        <View style={styles.configCard}>
          <Text style={styles.cardLabel}>HEADING</Text>
          <View style={styles.metricDetailRow}>
            <Text style={styles.metricValueLarge}>{Math.round(effectiveHeading)}° {effectiveDirection}</Text>
            <View style={styles.compassIconBadge}>
              <Text style={styles.compassEmoji}>🧭</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.navGrid}>
        <TouchableOpacity style={styles.navBlock} onPress={onNavigateTargets}>
          <Text style={styles.navIcon}>🎯</Text>
          <Text style={styles.navBlockTitle}>TARGETS</Text>
          <Text style={styles.navBlockDesc}>View & Manage</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBlock} onPress={onNavigateDiagnostics ?? onNavigateTargets}>
          <Text style={styles.navIcon}>📈</Text>
          <Text style={styles.navBlockTitle}>DIAGNOSTICS</Text>
          <Text style={styles.navBlockDesc}>Device Health</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBlock} onPress={onNavigatePorts}>
          <Text style={styles.navIcon}>🔌</Text>
          <Text style={styles.navBlockTitle}>PORTS</Text>
          <Text style={styles.navBlockDesc}>Open Services</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBlock} onPress={onNavigateOta}>
          <Text style={styles.navIcon}>☁️</Text>
          <Text style={styles.navBlockTitle}>OTA UPDATE</Text>
          <Text style={styles.navBlockDesc}>Update Devices</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050E17',
    paddingTop: 22,
    paddingBottom: 10,
    paddingHorizontal: 16,
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logoShield: { fontSize: 22 },
  headerTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  headerSubtitle: { color: '#00C9FF', fontSize: 10, fontWeight: '700', marginTop: -2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#00FF7A' },
  statusText: { color: '#7FA2B8', fontSize: 10 },
  runRadarBtn: {
    borderWidth: 1,
    borderColor: '#00A96B',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(0,169,107,0.05)',
  },
  runRadarText: { color: '#00FF7A', fontSize: 11, fontWeight: '700' },

  gridRow: { flexDirection: 'row', gap: 10, width: '100%' },
  configCard: { flex: 1, backgroundColor: '#091522', borderWidth: 1, borderColor: '#1D2D3F', borderRadius: 8, padding: 10 },
  cardLabel: { color: '#7FA2B8', fontSize: 9, fontWeight: '600', letterSpacing: 0.5 },
  cardValueMain: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginVertical: 1 },
  cardDesc: { color: '#52697A', fontSize: 9 },

  radarOuterContainer: {
    width: RADAR_SIZE,
    height: RADAR_SIZE,
    position: 'relative',
    marginVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardinalText: { position: 'absolute', color: '#52697A', fontSize: 13, fontWeight: '700' },
  radar: {
    width: RADAR_SIZE,
    height: RADAR_SIZE,
    borderRadius: RADAR_SIZE / 2,
    backgroundColor: '#02120E',
    borderWidth: 1.5,
    borderColor: '#00A96B',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  radarRing: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(0, 169, 107, 0.25)',
  },
  crossH: { position: 'absolute', top: RADAR_CENTER, left: 0, width: RADAR_SIZE, height: 1, backgroundColor: 'rgba(0, 169, 107, 0.25)' },
  crossV: { position: 'absolute', top: 0, left: RADAR_CENTER, width: 1, height: RADAR_SIZE, backgroundColor: 'rgba(0, 169, 107, 0.25)' },

  centerShieldOutter: {
    position: 'absolute',
    width: SHIELD_SIZE,
    height: SHIELD_SIZE,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomLeftRadius: 7,
    borderBottomRightRadius: 7,
    borderWidth: 1.8,
    borderColor: '#00A96B',
    backgroundColor: '#07141D',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
    top: RADAR_CENTER - SHIELD_SIZE / 2,
    left: RADAR_CENTER - SHIELD_SIZE / 2,
  },
  centerShieldOuterTip: {
    position: 'absolute',
    bottom: -6,
    left: '50%',
    marginLeft: -6,
    width: 12,
    height: 12,
    borderLeftWidth: 1.8,
    borderBottomWidth: 1.8,
    borderLeftColor: '#00A96B',
    borderBottomColor: '#00A96B',
    backgroundColor: '#07141D',
    transform: [{ rotate: '-45deg' }],
  },
  centerShieldInner: {
    width: SHIELD_SIZE - 8,
    height: SHIELD_SIZE - 8,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(0, 169, 107, 0.5)',
    backgroundColor: '#0A1A22',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  centerShieldInnerTip: {
    position: 'absolute',
    bottom: -4,
    left: '50%',
    marginLeft: -4,
    width: 8,
    height: 8,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    borderLeftColor: 'rgba(0, 169, 107, 0.5)',
    borderBottomColor: 'rgba(0, 169, 107, 0.5)',
    backgroundColor: '#0A1A22',
    transform: [{ rotate: '-45deg' }],
  },
  centerShieldGlyphWrap: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'flex-start',
    position: 'relative',
  },
  tTopBar: {
    width: 17,
    height: 4,
    borderRadius: 1.5,
    backgroundColor: '#6FE7B8',
    marginTop: 1,
  },
  tStem: {
    position: 'absolute',
    top: 4,
    width: 5,
    height: 12,
    borderRadius: 1,
    backgroundColor: '#5FD6AE',
  },
  tWingLeft: {
    position: 'absolute',
    top: 5,
    left: 1,
    width: 6,
    height: 8,
    borderRadius: 1,
    backgroundColor: '#00A96B',
    transform: [{ skewX: '-22deg' }],
  },
  tWingRight: {
    position: 'absolute',
    top: 5,
    right: 1,
    width: 6,
    height: 8,
    borderRadius: 1,
    backgroundColor: '#00A96B',
    transform: [{ skewX: '22deg' }],
  },
  dot: { position: 'absolute', width: 8, height: 8, borderRadius: 4, shadowRadius: 3, shadowOpacity: 0.6 },
  dotBle: { backgroundColor: '#00C9FF', shadowColor: '#00C9FF' },
  dotWifi: { backgroundColor: '#00FF7A', shadowColor: '#00FF7A' },

  counterBoxContainer: {
    flexDirection: 'row',
    backgroundColor: '#091522',
    borderWidth: 1,
    borderColor: '#1D2D3F',
    borderRadius: 8,
    width: '100%',
    height: 54,
  },
  counterSection: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  borderRight: { borderRightWidth: 1, borderRightColor: '#1D2D3F' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 1 },
  indicatorDot: { width: 6, height: 6, borderRadius: 3 },
  counterTitle: { color: '#7FA2B8', fontSize: 10, fontWeight: '500' },
  counterValue: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  metricDetailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  metricValueLarge: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  metricEmoji: { fontSize: 14 },
  compassIconBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,169,107,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  compassEmoji: { color: '#00A96B', fontSize: 9 },

  navGrid: { flexDirection: 'row', gap: 8, width: '100%' },
  navBlock: {
    flex: 1,
    backgroundColor: '#091522',
    borderWidth: 1,
    borderColor: '#1D2D3F',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  navIcon: { fontSize: 16, marginBottom: 2 },
  navBlockTitle: { color: '#FFFFFF', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  navBlockDesc: { color: '#52697A', fontSize: 8, marginTop: 1 },
});
