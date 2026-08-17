import React, { useMemo, useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Dimensions } from 'react-native';
import { Magnetometer } from 'expo-sensors';
import { RadiusBar } from './radiusbar';
import { OneEuroFilter } from './OneEuroFilter';
import { CommandTransport } from './CommandTransport';
import { calculateRadarCoordinates } from './RenderTargets';
import { updateTargetSignal } from './updateTargetSignal';

// 1. Updated data layout mapping to native Bonjour / DNS-SD structures
type BonjourTarget = {
  id: string;
  serviceName: string;
  hostName: string;
  serviceType: string;
  distanceM: number;
  angleDeg: number;
  rssi?: number;
  type?: 'BLE' | 'WiFi';
  txtMetadata: {
    version?: string;
    status?: string;
    load?: string;
    [key: string]: string | undefined;
  };
};

type RadarScreenProps = {
  discoveredServices: BonjourTarget[];
  isScanning: boolean;
  txtPacketsParsed: number;
  activeWebSocket?: WebSocket | null;
  bleManager?: any;
  activePeripheralId?: string | null;
  activeNodeId?: string | null;
  bleServiceUUID?: string;
  bleTxCharacteristicUUID?: string;
  bleRxCharacteristicUUID?: string;
  onToggleScan?: () => void;
  onNavigateTargets?: () => void;
  onNavigateDiagnostics?: () => void;
  onNavigatePorts?: () => void;
  onNavigateOta?: () => void;
  onSelectDevice?: (device: any) => void;
};

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const RADAR_SIZE = SCREEN_HEIGHT < 700 ? 210 : 250;
const RADAR_CENTER = RADAR_SIZE / 2;
const SHIELD_SIZE = 34;
const MIN_TARGET_OFFSET_PX = SHIELD_SIZE / 2 + 8;

export default function RadarScreen({
  discoveredServices,
  isScanning,
  txtPacketsParsed,
  activeWebSocket = null,
  bleManager = null,
  activePeripheralId = null,
  activeNodeId = null,
  bleServiceUUID,
  bleTxCharacteristicUUID,
  bleRxCharacteristicUUID,
  onToggleScan,
  onNavigateTargets,
  onNavigateDiagnostics,
  onNavigatePorts,
  onNavigateOta,
  onSelectDevice,
}: RadarScreenProps) {
  const [radiusM, setRadiusM] = useState(25);
  const [compassHeading, setCompassHeading] = useState(0);
  const [cardinalDirection, setCardinalDirection] = useState('N');
  const [commandState, setCommandState] = useState<{ key: string | null; phase: 'idle' | 'loading' | 'success' | 'error' }>({
    key: null,
    phase: 'idle',
  });
  const filtersRef = useRef<Record<string, { distance: OneEuroFilter; angle: OneEuroFilter }>>({});
  const rssiHistoryRef = useRef<Map<string, number>>(new Map());
  const transportRef = useRef<CommandTransport | null>(null);

  useEffect(() => {
    const targetPeripheralId = activePeripheralId ?? activeNodeId ?? discoveredServices[0]?.id ?? null;
    transportRef.current = new CommandTransport({
      webSocket: activeWebSocket,
      bleManager,
      peripheralId: targetPeripheralId,
      serviceUUID: bleServiceUUID,
      txCharacteristicUUID: bleTxCharacteristicUUID,
      rxCharacteristicUUID: bleRxCharacteristicUUID,
    });
  }, [
    activeWebSocket,
    bleManager,
    activePeripheralId,
    activeNodeId,
    bleServiceUUID,
    bleTxCharacteristicUUID,
    bleRxCharacteristicUUID,
    discoveredServices,
  ]);

  const executeRpc = async (key: string, method: string, params?: any) => {
    const transport = transportRef.current;
    if (!transport) return;

    setCommandState({ key, phase: 'loading' });
    try {
      await transport.executeCommand(method, params);
      setCommandState({ key, phase: 'success' });
    } catch {
      setCommandState({ key, phase: 'error' });
    } finally {
      setTimeout(() => {
        setCommandState((current) => (current.key === key ? { key: null, phase: 'idle' } : current));
      }, 900);
    }
  };

  const getActionStyle = (key: string) => {
    if (commandState.key !== key) return null;
    if (commandState.phase === 'loading') return styles.actionLoading;
    if (commandState.phase === 'success') return styles.actionSuccess;
    if (commandState.phase === 'error') return styles.actionError;
    return null;
  };

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

  const smoothedServices = useMemo(() => {
    const timestamp = performance.now();
    const activeIds = new Set(discoveredServices.map((service) => service.id));

    Object.keys(filtersRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        delete filtersRef.current[id];
      }
    });

    return discoveredServices.map((service) => {
      const key = service.id;
      if (!filtersRef.current[key]) {
        filtersRef.current[key] = {
          distance: new OneEuroFilter(1.0, 0.01, 1.0),
          angle: new OneEuroFilter(1.0, 0.01, 1.0),
        };
      }

      const rawDistance = Number.isFinite(service.distanceM) ? Number(service.distanceM) : 0;
      const hasHardwareAngle = Number.isFinite(service.angleDeg);
      const rawAngle = hasHardwareAngle ? Number(service.angleDeg) : 0;

      const smoothedDistanceM = filtersRef.current[key].distance.filter(rawDistance, timestamp);
      const smoothedAngleDeg = filtersRef.current[key].angle.filter(rawAngle, timestamp);

      return {
        ...service,
        smoothedDistanceM,
        smoothedAngleDeg,
        hasHardwareAngle,
      };
    });
  }, [discoveredServices]);

  const visibleServices = useMemo(
    () => smoothedServices.filter((s) => Number.isFinite(s.smoothedDistanceM) && s.smoothedDistanceM >= 0 && s.smoothedDistanceM <= radiusM),
    [smoothedServices, radiusM],
  );

  useEffect(() => {
    const activeIds = new Set(visibleServices.map((service) => service.id));
    rssiHistoryRef.current.forEach((_, id) => {
      if (!activeIds.has(id)) {
        rssiHistoryRef.current.delete(id);
      }
    });
  }, [visibleServices]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <View style={styles.logoRow}>
            <Text style={styles.logoShield}>🛡️</Text>
            <View>
              <Text style={styles.headerTitle}>TRUSTWIRE</Text>
              <Text style={styles.headerSubtitle}>BONJOUR / DNS-SD DISCOVERY</Text>
            </View>
          </View>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: isScanning ? '#00FF7A' : '#52697A' }]} />
            <Text style={styles.statusText}>
              {isScanning ? 'Passive Net Service Browsing' : 'Discovery Idle'}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.runRadarBtn, getActionStyle('run-radar')]}
          onPress={async () => {
            await executeRpc('run-radar', 'scanner/toggle', { enabled: !isScanning });
            onToggleScan?.();
          }}
        >
          <Text style={styles.runRadarText}>📡 NSD SCAN</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.gridRow}>
        <View style={styles.configCard}>
          <Text style={styles.cardLabel}>SCAN RADIUS</Text>
          <Text style={styles.cardValueMain}>{Math.round(radiusM)}m</Text>
          <Text style={styles.cardDesc}>Proximity Boundary</Text>
        </View>
        <View style={styles.configCard}>
          <Text style={styles.cardLabel}>TXT PAYLOADS</Text>
          <Text style={styles.cardValueMain}>{txtPacketsParsed}</Text>
          <Text style={styles.cardDesc}>Connectionless Extractions</Text>
        </View>
      </View>

      <View style={styles.radarOuterContainer}>
        <Text style={[styles.cardinalText, { top: -22, left: RADAR_CENTER - 6 }]}>N</Text>
        <Text style={[styles.cardinalText, { bottom: -22, left: RADAR_CENTER - 5 }]}>S</Text>
        <Text style={[styles.cardinalText, { left: -20, top: RADAR_CENTER - 8 }]}>W</Text>
        <Text style={[styles.cardinalText, { right: -20, top: RADAR_CENTER - 8 }]}>E</Text>

        <View style={[styles.radar, { transform: [{ rotate: `${-compassHeading}deg` }] }]}>
          <View style={[styles.radarRing, { width: RADAR_SIZE * 0.25, height: RADAR_SIZE * 0.25, borderRadius: (RADAR_SIZE * 0.25) / 2 }]} />
          <View style={[styles.radarRing, { width: RADAR_SIZE * 0.50, height: RADAR_SIZE * 0.50, borderRadius: (RADAR_SIZE * 0.50) / 2 }]} />
          <View style={[styles.radarRing, { width: RADAR_SIZE * 0.75, height: RADAR_SIZE * 0.75, borderRadius: (RADAR_SIZE * 0.75) / 2 }]} />
          <View style={[styles.radarRing, { width: RADAR_SIZE, height: RADAR_SIZE, borderRadius: RADAR_SIZE / 2 }]} />

          <View style={styles.crossH} />
          <View style={styles.crossV} />

          {visibleServices.map((s, index) => {
            const safeAngleDeg = Number.isFinite(s.smoothedAngleDeg) ? s.smoothedAngleDeg : 0;
            const safeDistance = Number.isFinite(s.smoothedDistanceM) ? Math.max(0, s.smoothedDistanceM) : 0;
            const angle = ((safeAngleDeg - 90) * Math.PI) / 180;
            const rawRadius = (safeDistance / Math.max(radiusM, 1)) * (RADAR_CENTER - 16);
            const r = Math.max(MIN_TARGET_OFFSET_PX, rawRadius);
            const fallbackCoords = calculateRadarCoordinates(
              {
                id: s.id,
                rssi: Number(
                  updateTargetSignal(
                    rssiHistoryRef.current,
                    s.id,
                    Number.isFinite(s.rssi) ? Number(s.rssi) : -88,
                  ).get(s.id) ?? -88,
                ),
                type: s.type || 'WiFi',
              },
              index,
              visibleServices.length,
              RADAR_CENTER - 16,
            );
            const fallbackMagnitude = Math.hypot(fallbackCoords.x, fallbackCoords.y);
            const fallbackScale = fallbackMagnitude > 0 && fallbackMagnitude < MIN_TARGET_OFFSET_PX
              ? MIN_TARGET_OFFSET_PX / fallbackMagnitude
              : 1;
            const fallbackX = fallbackCoords.x * fallbackScale;
            const fallbackY = fallbackCoords.y * fallbackScale;
            const x = s.hasHardwareAngle ? Math.cos(angle) * r : fallbackX;
            const y = s.hasHardwareAngle ? Math.sin(angle) * r : fallbackY;
            return (
              <TouchableOpacity
                key={s.serviceName}
                onPress={() => onSelectDevice?.(s)}
                accessibilityLabel={`${s.serviceName} • ${safeDistance.toFixed(1)}m @ ${Math.round(safeAngleDeg)}°`}
                style={[
                  styles.dot,
                  s.txtMetadata.status === 'alert' ? styles.dotAlert : styles.dotActive,
                  { left: RADAR_CENTER + x - 4, top: RADAR_CENTER + y - 4 },
                ]}
              />
            );
          })}
        </View>

        <View style={styles.centerShieldOutter} pointerEvents="none">
          <View style={styles.centerShieldInner}>
            <Text style={styles.centerGlyph}>⬢</Text>
          </View>
        </View>
      </View>

      <RadiusBar value={radiusM} onChange={setRadiusM} min={1} max={100} />

      <View style={styles.counterBoxContainer}>
        <TouchableOpacity
          style={[styles.counterSection, styles.borderRight, getActionStyle('pool-block')]}
          onPress={() => executeRpc('pool-block', 'diagnostics/poolSnapshot', { services: visibleServices.length })}
        >
          <Text style={styles.counterTitle}>MDNS SERVICES POOL</Text>
          <Text style={styles.counterValue}>{visibleServices.length}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.counterSection, getActionStyle('txt-block')]}
          onPress={() => executeRpc('txt-block', 'txt/streamProbe', { parsed: txtPacketsParsed })}
        >
          <Text style={styles.counterTitle}>TXT RECORD STREAM</Text>
          <Text style={[styles.counterValue, { color: '#00FF7A' }]}>PASSIVE LINK</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.gridRow}>
        <View style={styles.configCard}>
          <Text style={styles.cardLabel}>RESOLVED HOSTNAMES</Text>
          <View style={styles.metricDetailRow}>
            <Text style={styles.metricValueLarge}>{discoveredServices.length} Local</Text>
            <Text style={{ fontSize: 14 }}>🏷️</Text>
          </View>
        </View>
        <View style={styles.configCard}>
          <Text style={styles.cardLabel}>HEADING</Text>
          <View style={styles.metricDetailRow}>
            <Text style={styles.metricValueLarge}>{Math.round(compassHeading)}° {cardinalDirection}</Text>
            <View style={styles.compassIconBadge}><Text style={{ color: '#00A96B', fontSize: 9 }}>🧭</Text></View>
          </View>
        </View>
      </View>

      <View style={styles.navGrid}>
        <TouchableOpacity
          style={[styles.navBlock, getActionStyle('services-nav')]}
          onPress={async () => {
            await executeRpc('services-nav', 'services/browse', { scope: 'mdns' });
            onNavigateTargets?.();
          }}
        >
          <Text style={styles.navIcon}>🎯</Text>
          <Text style={styles.navBlockTitle}>SERVICES</Text>
          <Text style={styles.navBlockDesc}>mDNS Browsing</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.navBlock, getActionStyle('diagnostics-nav')]}
          onPress={async () => {
            await executeRpc('diagnostics-nav', 'diagnostics/testPayload', { suite: 'network-layers' });
            (onNavigateDiagnostics ?? onNavigateTargets)?.();
          }}
        >
          <Text style={styles.navIcon}>📈</Text>
          <Text style={styles.navBlockTitle}>DIAGNOSTICS</Text>
          <Text style={styles.navBlockDesc}>Network Layers</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.navBlock, getActionStyle('serial-nav')]}
          onPress={async () => {
            await executeRpc('serial-nav', 'serial/testPayload', { channel: 'passive-monitor' });
            onNavigatePorts?.();
          }}
        >
          <Text style={styles.navIcon}>🔌</Text>
          <Text style={styles.navBlockTitle}>TXT RECORDS</Text>
          <Text style={styles.navBlockDesc}>Passive Payload</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.navBlock, getActionStyle('ota-nav')]}
          onPress={async () => {
            await executeRpc('ota-nav', 'device/otaCheck');
            onNavigateOta?.();
          }}
        >
          <Text style={styles.navIcon}>☁️</Text>
          <Text style={styles.navBlockTitle}>NODE OTA</Text>
          <Text style={styles.navBlockDesc}>Bonjour Flash</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050E17', paddingTop: 44, paddingBottom: 12, paddingHorizontal: 16, justifyContent: 'space-between', alignItems: 'center' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logoShield: { fontSize: 22 },
  headerTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  headerSubtitle: { color: '#00FF7A', fontSize: 10, fontWeight: '700', marginTop: -2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { color: '#7FA2B8', fontSize: 10 },
  runRadarBtn: { borderWidth: 1, borderColor: '#00A96B', borderRadius: 6, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: 'rgba(0,169,107,0.05)' },
  runRadarText: { color: '#00FF7A', fontSize: 11, fontWeight: '700' },

  gridRow: { flexDirection: 'row', gap: 10, width: '100%' },
  configCard: { flex: 1, backgroundColor: '#091522', borderWidth: 1, borderColor: '#1D2D3F', borderRadius: 8, padding: 10 },
  cardLabel: { color: '#7FA2B8', fontSize: 9, fontWeight: '600', letterSpacing: 0.5 },
  cardValueMain: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginVertical: 1 },
  cardDesc: { color: '#52697A', fontSize: 9 },

  radarOuterContainer: { width: RADAR_SIZE, height: RADAR_SIZE, position: 'relative', marginVertical: 14, alignItems: 'center', justifyContent: 'center' },
  cardinalText: { position: 'absolute', color: '#52697A', fontSize: 12, fontWeight: '700' },
  radar: { width: RADAR_SIZE, height: RADAR_SIZE, borderRadius: RADAR_SIZE / 2, backgroundColor: '#02120E', borderWidth: 1.5, borderColor: '#00A96B', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', position: 'relative' },
  radarRing: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(0, 169, 107, 0.22)' },
  crossH: { position: 'absolute', top: RADAR_CENTER, left: 0, width: RADAR_SIZE, height: 1, backgroundColor: 'rgba(0, 169, 107, 0.22)' },
  crossV: { position: 'absolute', top: 0, left: RADAR_CENTER, width: 1, height: RADAR_SIZE, backgroundColor: 'rgba(0, 169, 107, 0.22)' },

  centerShieldOutter: { position: 'absolute', width: SHIELD_SIZE, height: SHIELD_SIZE, borderRadius: SHIELD_SIZE / 2, borderWidth: 1.5, borderColor: '#00A96B', backgroundColor: '#050E17', alignItems: 'center', justifyContent: 'center', top: RADAR_CENTER - SHIELD_SIZE / 2, left: RADAR_CENTER - SHIELD_SIZE / 2 },
  centerShieldInner: { width: SHIELD_SIZE - 8, height: SHIELD_SIZE - 8, borderRadius: (SHIELD_SIZE - 8) / 2, borderWidth: 1, borderColor: 'rgba(0, 169, 107, 0.3)', backgroundColor: '#02120E', alignItems: 'center', justifyContent: 'center' },
  centerGlyph: { color: '#00A96B', fontSize: 11, fontWeight: '900' },

  dot: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
  dotActive: { backgroundColor: '#00FF7A' },
  dotAlert: { backgroundColor: '#FF3B30' },

  counterBoxContainer: { flexDirection: 'row', backgroundColor: '#091522', borderWidth: 1, borderColor: '#1D2D3F', borderRadius: 8, width: '100%', height: 50 },
  counterSection: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  borderRight: { borderRightWidth: 1, borderRightColor: '#1D2D3F' },
  counterTitle: { color: '#7FA2B8', fontSize: 9, fontWeight: '600', marginBottom: 2, letterSpacing: 0.3 },
  counterValue: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },

  metricDetailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  metricValueLarge: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  compassIconBadge: { width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,169,107,0.1)', alignItems: 'center', justifyContent: 'center' },

  navGrid: { flexDirection: 'row', gap: 8, width: '100%' },
  navBlock: { flex: 1, backgroundColor: '#091522', borderWidth: 1, borderColor: '#1D2D3F', borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  navIcon: { fontSize: 16, marginBottom: 2 },
  navBlockTitle: { color: '#FFFFFF', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  navBlockDesc: { color: '#52697A', fontSize: 8, marginTop: 1 },

  actionLoading: {
    borderColor: '#00E5FF',
    borderWidth: 1.5,
    backgroundColor: 'rgba(0, 229, 255, 0.08)',
  },
  actionSuccess: {
    borderColor: '#00FF7A',
    borderWidth: 1.5,
    backgroundColor: 'rgba(0, 255, 122, 0.1)',
  },
  actionError: {
    borderColor: '#FF3B30',
    borderWidth: 1.5,
    backgroundColor: 'rgba(255, 59, 48, 0.1)',
  },
});
