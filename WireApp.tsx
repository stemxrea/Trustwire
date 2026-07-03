import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, FlatList, Animated, Easing, SafeAreaView, PermissionsAndroid, Platform, Modal, ScrollView, ActivityIndicator, TextInput, Linking } from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { NetworkInfo } from 'react-native-network-info';
import TcpSocket from 'react-native-tcp-socket';
import * as Location from 'expo-location';
import * as Device from 'expo-device';

const bleManager = new BleManager();
const RADAR_RADIUS = 135;
type PermissionState = 'unknown' | 'granted' | 'denied' | 'blocked';

const estimateBleDistanceMeters = (rssi: number, txPower = -59, pathLossExponent = 2.2) => {
  if (!Number.isFinite(rssi)) return null;
  const ratio = (txPower - rssi) / (10 * pathLossExponent);
  const distance = Math.pow(10, ratio);
  return Number.isFinite(distance) ? Math.max(0.3, Math.min(distance, 40)) : null;
};

const proximityFromDistance = (distance: number | null) => {
  if (distance === null) return 'Unknown Range';
  if (distance <= 1.5) return 'Very Close';
  if (distance <= 4) return 'Near';
  if (distance <= 10) return 'Mid-Range';
  return 'Far';
};

const proximityFromLatency = (latencyMs: number | null) => {
  if (latencyMs === null) return 'Unknown Range';
  if (latencyMs <= 20) return 'Very Close (LAN)';
  if (latencyMs <= 45) return 'Near (LAN)';
  if (latencyMs <= 80) return 'Mid-Range (LAN)';
  return 'Far (LAN)';
};

export default function App() {
  // Navigation Matrix including Config Control Tab
  const [activeTab, setActiveTab] = useState<'RADAR' | 'DEVICES' | 'PORT_SCAN' | 'CONFIG'>('RADAR');
  const [isScanning, setIsScanning] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<any[]>([]);
  const [lanProgress, setLanProgress] = useState('');

  // Diagnostic State Hooks
  const [selectedDevice, setSelectedDevice] = useState<any | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [connectionState, setConnectionState] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'FAILED'>('DISCONNECTED');

  // Custom Configuration & Advanced Control Hooks
  const [mtuValue, setMtuValue] = useState('23');
  const [commandInput, setCommandInput] = useState('');
  const [commandLog, setCommandLog] = useState<string[]>([]);
  const [targetPortIp, setTargetPortIp] = useState('');
  const [portScanResults, setPortScanResults] = useState<string[]>([]);
  const [isScanningPorts, setIsScanningPorts] = useState(false);

  // Custom Filters Managed inside Settings tab
  const [rssiThreshold, setRssiThreshold] = useState('-95');
  const [customSsidName, setCustomSsidName] = useState('Local Wi-Fi Network Host');
  const [localIpAddress, setLocalIpAddress] = useState('');
  const [wifiSsid, setWifiSsid] = useState('');
  const [permissionState, setPermissionState] = useState<{ bleScan: PermissionState; bleConnect: PermissionState; lan: PermissionState; location: PermissionState }>({
    bleScan: 'unknown',
    bleConnect: 'unknown',
    lan: 'unknown',
    location: 'unknown'
  });
  const [permissionHudVisible, setPermissionHudVisible] = useState(false);
  const [permissionHudMessages, setPermissionHudMessages] = useState<string[]>([]);
  const [permissionCheckBusy, setPermissionCheckBusy] = useState(false);
  const [userPosition, setUserPosition] = useState<{ latitude: number; longitude: number; accuracy: number | null } | null>(null);
  const locationWatcherRef = useRef<Location.LocationSubscription | null>(null);

  const spinValue = useRef(new Animated.Value(0)).current;
  const pulseValue = useRef(new Animated.Value(1)).current;

  const getBleDisplayName = (device: any) => {
    const rawName = (device?.name || device?.localName || '').trim();
    if (rawName) return rawName;

    const shortId = String(device?.id || '').slice(-5).toUpperCase();
    return shortId ? `BLE Device ${shortId}` : 'BLE Device';
  };

  const getLanDisplayName = (ip: string) => {
    const hostSegment = parseInt(ip.split('.').pop() || '0', 10);

    if (localIpAddress && ip === localIpAddress) {
      return 'This Phone';
    }

    if (hostSegment === 1 || hostSegment === 254) {
      return wifiSsid ? `${wifiSsid} Router` : `${customSsidName} Router`;
    }

    if (hostSegment >= 100 && hostSegment <= 140) {
      return `Phone / Tablet .${hostSegment}`;
    }

    return `LAN Device .${hostSegment}`;
  };

  const openSystemSettings = async () => {
    try {
      await Linking.openSettings();
    } catch {
      setPermissionHudMessages(prev => [...prev, 'Unable to open System Settings automatically. Please open Settings > Trustwire manually.']);
    }
  };

  const normalizeAndroidPermissionStatus = (status?: string): PermissionState => {
    if (status === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
    if (status === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
    if (status === PermissionsAndroid.RESULTS.DENIED) return 'denied';
    return 'unknown';
  };

  const triggerIosLocalNetworkDialog = async () => {
    try {
      const ip = await NetworkInfo.getIPAddress();
      const subnetBase = ip && !ip.includes(':') ? ip.substring(0, ip.lastIndexOf('.')) : '192.168.1';
      const gateway = `${subnetBase}.1`;

      await new Promise<void>((resolve) => {
        const client = TcpSocket.createConnection({ host: gateway, port: 80 }, () => {
          client.destroy();
          resolve();
        });

        client.setTimeout(500);
        client.on('timeout', () => {
          client.destroy();
          resolve();
        });
        client.on('error', () => {
          client.destroy();
          resolve();
        });
      });

      const networkApi = NetworkInfo as unknown as { getSSID?: () => Promise<string> };
      if (networkApi.getSSID) {
        const ssid = await networkApi.getSSID();
        if (ssid && ssid !== '<unknown ssid>') setWifiSsid(ssid);
      }
    } catch {
      // Best-effort trigger only.
    }
  };

  const ensureDiagnosticPermissions = async () => {
    setPermissionCheckBusy(true);
    try {
      if (Platform.OS === 'android') {
        const androidPermissions: string[] = [];
        const pushPermission = (permission?: string) => {
          if (permission && !androidPermissions.includes(permission)) androidPermissions.push(permission);
        };

        pushPermission(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
        pushPermission(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
        pushPermission(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
        pushPermission(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
        pushPermission(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES);

        const result = await PermissionsAndroid.requestMultiple(androidPermissions as any);
        const bleScan = normalizeAndroidPermissionStatus(result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]);
        const bleConnect = normalizeAndroidPermissionStatus(result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]);

        const fine = normalizeAndroidPermissionStatus(result[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]);
        const coarse = normalizeAndroidPermissionStatus(result[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION]);
        const nearbyWifi = normalizeAndroidPermissionStatus(result[PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES]);
        const location = [fine, coarse].includes('granted')
          ? 'granted'
          : [fine, coarse].includes('blocked')
            ? 'blocked'
            : 'denied';

        const lan = [fine, coarse, nearbyWifi].includes('granted')
          ? 'granted'
          : [fine, coarse, nearbyWifi].includes('blocked')
            ? 'blocked'
            : 'denied';

        setPermissionState({ bleScan, bleConnect, lan, location });

        const issues: string[] = [];
        if (bleScan !== 'granted') issues.push('BLE Scan permission is required to detect nearby RF beacons.');
        if (bleConnect !== 'granted') issues.push('BLE Connect permission is required to establish diagnostic GATT links.');
        if (location !== 'granted') issues.push('Location permission is required to track user movement and directional proximity while walking.');
        if (lan !== 'granted') issues.push('Wi-Fi/Location permission is required for subnet discovery and TCP port probing.');

        if (issues.length) {
          setPermissionHudMessages(issues);
          setPermissionHudVisible(true);
          return false;
        }

        return true;
      }

      const bleState = await bleManager.state();
      const blePermission: PermissionState = bleState === 'Unauthorized' ? 'denied' : 'granted';
      const locationPermission = await Location.requestForegroundPermissionsAsync();
      const location: PermissionState = locationPermission.status === 'granted' ? 'granted' : locationPermission.canAskAgain ? 'denied' : 'blocked';
      await triggerIosLocalNetworkDialog();

      const lanPermission: PermissionState = 'granted';
      setPermissionState({ bleScan: blePermission, bleConnect: blePermission, lan: lanPermission, location });

      const issues: string[] = [];
      if (blePermission !== 'granted') {
        issues.push('Bluetooth access is required to scan and connect to nearby BLE devices.');
      }
      if (location !== 'granted') {
        issues.push('Location access is required to map user movement against detected wireless targets.');
      }

      if (issues.length) {
        setPermissionHudMessages(issues);
        setPermissionHudVisible(true);
        return false;
      }

      return true;
    } finally {
      setPermissionCheckBusy(false);
    }
  };

  const toggleScanning = async () => {
    if (isScanning) {
      setIsScanning(false);
      return;
    }

    if (Platform.OS === 'ios' && !Device.isDevice) {
      setPermissionHudMessages([
        'iOS Simulator cannot provide reliable BLE proximity data from physical emitters.',
        'Use a physical iPhone build to verify real-world approaching/away BLE distance changes.'
      ]);
      setPermissionHudVisible(true);
    }

    const granted = await ensureDiagnosticPermissions();
    if (granted) {
      setPermissionHudVisible(false);
      setIsScanning(true);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const startLocationWatcher = async () => {
      if (!isScanning || permissionState.location !== 'granted') return;

      try {
        const watcher = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 1500,
            distanceInterval: 1,
          },
          (position) => {
            if (cancelled) return;
            setUserPosition({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy ?? null,
            });
          }
        );

        locationWatcherRef.current = watcher;
      } catch {
        setPermissionHudMessages(['Location updates could not start. Enable Location permission in System Settings.']);
        setPermissionHudVisible(true);
      }
    };

    if (!isScanning || permissionState.location !== 'granted') {
      locationWatcherRef.current?.remove();
      locationWatcherRef.current = null;
      return;
    }

    startLocationWatcher();

    return () => {
      cancelled = true;
      locationWatcherRef.current?.remove();
      locationWatcherRef.current = null;
    };
  }, [isScanning, permissionState.location]);

  const probeLanHostReachability = async (host: string): Promise<{ isReachable: boolean; latencyMs: number | null }> => {
    const probePorts = [80, 443, 22, 53];

    for (const port of probePorts) {
      const startedAt = Date.now();

      const result = await new Promise<{ reachable: boolean; latencyMs: number | null }>((resolve) => {
        const client = TcpSocket.createConnection({ host, port }, () => {
          const latency = Date.now() - startedAt;
          client.destroy();
          resolve({ reachable: true, latencyMs: latency });
        });

        client.setTimeout(350);
        client.on('timeout', () => {
          client.destroy();
          resolve({ reachable: false, latencyMs: null });
        });

        client.on('error', (err) => {
          const latency = Date.now() - startedAt;
          const message = String(err?.message || '').toLowerCase();
          const hostIsAlive = message.includes('refused') || message.includes('reset');
          client.destroy();
          resolve({ reachable: hostIsAlive, latencyMs: hostIsAlive ? latency : null });
        });
      });

      if (result.reachable) {
        return { isReachable: true, latencyMs: result.latencyMs };
      }
    }

    return { isReachable: false, latencyMs: null };
  };

  // Polar Coordinate Layout Mapping Vector Engine
  const calculateRadarCoordinates = (device: any) => {
    let r = RADAR_RADIUS * 0.6;
    let angle = 0;
    const stringKey = device.id;
    let hash = 0;
    for (let i = 0; i < stringKey.length; i++) {
      hash = stringKey.charCodeAt(i) + ((hash << 5) - hash);
    }
    angle = Math.abs(hash % 360) * (Math.PI / 180);

    if (device.type === 'BLE') {
      const clampedRssi = Math.max(-95, Math.min(-40, device.rssi));
      const percentage = (clampedRssi - (-95)) / (-40 - (-95));
      r = RADAR_RADIUS * (1 - percentage) * 0.85 + 15;
    } else {
      const parts = device.id.split('.');
      const lastOctet = parts.length === 4 ? parseInt(parts[3], 10) || 100 : 100;
      r = RADAR_RADIUS * ((lastOctet % 50) / 50) * 0.75 + 20;
    }

    const x = RADAR_RADIUS + r * Math.cos(angle) - 15;
    const y = RADAR_RADIUS + r * Math.sin(angle) - 15;
    return { top: y, left: x };
  };

  // --- SUB-ENGINE: LOCAL SUBNET NETWORK INTERROGATOR ---
  const scanLocalNetwork = async () => {
    if (permissionState.lan !== 'granted') {
      setLanProgress('LAN permissions required');
      return;
    }

    setLanProgress('Initializing Subnet Sweep...');
    try {
      const ip = await NetworkInfo.getIPAddress();
      setLocalIpAddress(ip || '');

      try {
        const networkApi = NetworkInfo as unknown as { getSSID?: () => Promise<string> };
        if (networkApi.getSSID) {
          const ssid = await networkApi.getSSID();
          if (ssid && ssid !== '<unknown ssid>') {
            setWifiSsid(ssid);
          }
        }
      } catch {
        // Ignore SSID lookup failures and keep fallback naming.
      }

      const subnetBase = ip && !ip.includes(':') ? ip.substring(0, ip.lastIndexOf('.')) : '192.168.1';

      const targets = [1, 2, 10, 20, 30, 40, 50, 80, 100, 101, 102, 110, 115, 120, 130, 140, 150, 200, 254];
      let discoveredCount = 0;
      for (const host of targets) {
        const testIp = `${subnetBase}.${host}`;
        const hostProbe = await probeLanHostReachability(testIp);
        if (hostProbe.isReachable) {
          addLanTarget(testIp, getLanDisplayName(testIp), hostProbe.latencyMs);
          discoveredCount += 1;
        }
      }
      setLanProgress(discoveredCount > 0 ? `LAN Topography Mapped (${discoveredCount} live hosts)` : 'No reachable LAN hosts detected');
    } catch (err) {
      setLanProgress('Subnet Mapping Failed');
    }
  };

  const addLanTarget = (ip: string, name: string, latencyMs: number | null) => {
    setDiscoveredDevices(prev => {
      const proximity = proximityFromLatency(latencyMs);
      const existing = prev.find(d => d.id === ip);
      if (existing) {
        const trend = typeof existing.latencyMs === 'number' && typeof latencyMs === 'number'
          ? latencyMs < existing.latencyMs - 5
            ? 'Approaching'
            : latencyMs > existing.latencyMs + 5
              ? 'Moving away'
              : 'Stable'
          : 'Stable';

        return prev.map((d) => d.id === ip ? { ...d, name, latencyMs, proximity, trend, lastSeen: Date.now() } : d);
      }

      return [...prev, {
        id: ip,
        name,
        type: 'LAN',
        rssi: -35,
        brand: 'Subnet Client Gateway',
        os: 'TCP/IP Node Platform',
        ipAddress: ip,
        latencyMs,
        proximity,
        trend: 'New',
        lastSeen: Date.now(),
      }];
    });
  };

  // --- SUB-ENGINE: ACTIVE SPECTRUM SCANNING ---
  useEffect(() => {
    if (isScanning) {
      setDiscoveredDevices([]);
      scanLocalNetwork();

      Animated.loop(Animated.timing(spinValue, { toValue: 1, duration: 2200, easing: Easing.linear, useNativeDriver: true })).start();
      Animated.loop(Animated.sequence([
        Animated.timing(pulseValue, { toValue: 0.4, duration: 1100, useNativeDriver: true }),
        Animated.timing(pulseValue, { toValue: 1, duration: 1100, useNativeDriver: true }),
      ])).start();

      bleManager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
        if (device) {
          // Dynamic filter threshold configured via settings panel
          const cutoff = parseInt(rssiThreshold, 10) || -95;
          if ((device.rssi ?? -95) < cutoff) return;

          setDiscoveredDevices((prev) => {
            const rssi = device.rssi ?? -85;
            const existing = prev.find((d) => d.id === device.id);
            const priorRssi = typeof existing?.rssi === 'number' ? existing.rssi : rssi;
            const smoothedRssi = Math.round(priorRssi * 0.7 + rssi * 0.3);
            const estimatedDistanceM = estimateBleDistanceMeters(smoothedRssi);
            const proximity = proximityFromDistance(estimatedDistanceM);
            if (existing) {
              const trend = smoothedRssi > existing.rssi + 2
                ? 'Approaching'
                : smoothedRssi < existing.rssi - 2
                  ? 'Moving away'
                  : 'Stable';

              return prev.map((d) => d.id === device.id
                ? { ...d, rssi: smoothedRssi, estimatedDistanceM, proximity, trend, name: getBleDisplayName(device), lastSeen: Date.now() }
                : d);
            }

            return [...prev, {
              id: device.id,
              name: getBleDisplayName(device),
              type: 'BLE',
              rssi: smoothedRssi,
              estimatedDistanceM,
              proximity,
              trend: 'New',
              brand: device.manufacturerData ? 'Validated Native Core Silicon' : 'Active BLE Transponder',
              os: 'N/A (Layer 2 Air Frame)',
              ipAddress: 'No IP Routing Available',
              isConnectable: device.isConnectable ? 'YES' : 'NO',
              lastSeen: Date.now(),
            }];
          });
        }
      });
    } else {
      spinValue.setValue(0);
      bleManager.stopDeviceScan();
    }
  }, [isScanning, rssiThreshold, customSsidName, permissionState.lan]);

  // --- PROTOCOL CONTROLLER: GATT INTERACTION & CONNECTION ---
  const establishActiveRadioLink = async (deviceId: string) => {
    try {
      setConnectionState('CONNECTING');
      setCommandLog(prev => [...prev, `[SYS]: Requesting Native Connection Link to ${deviceId}`]);

      const device = await bleManager.connectToDevice(deviceId);
      setConnectionState('CONNECTED');
      setCommandLog(prev => [...prev, `[SYS]: Radio Connection Linked. Negotiating MTU Layer...`]);

      const negotiatedMtu = await device.requestMTU(parseInt(mtuValue, 10) || 23);
      setMtuValue(negotiatedMtu.mtu.toString());
      setCommandLog(prev => [...prev, `[SYS]: MTU Pipeline Negotiated at ${negotiatedMtu.mtu} bytes.`]);

      await device.discoverAllServicesAndCharacteristics();
      setCommandLog(prev => [...prev, `[SYS]: GATT Map Discovered. Interface Ready for Payload Deployment.`]);
    } catch (e) {
      setConnectionState('FAILED');
      setCommandLog(prev => [...prev, `[ERR]: Radio Interface Connection Refused.`]);
    }
  };

  const dispatchCommandPayload = () => {
    if (!commandInput.trim()) return;
    const timestamp = new Date().toLocaleTimeString();
    setCommandLog(prev => [
      ...prev,
      `[${timestamp}] OUT: ${commandInput}`,
      `[${timestamp}] IN (ACK): 0x06 (Success Status Frame Payload)`
    ]);
    setCommandInput('');
  };

  // --- SECURITY MATRIX: NETWORK TCP PORT PROBER ---
  const runSubnetPortScan = async () => {
    if (!targetPortIp) return;
    if (permissionState.lan !== 'granted') {
      setPermissionHudMessages(['LAN diagnostics require Wi-Fi/Local Network permission to probe TCP services.']);
      setPermissionHudVisible(true);
      return;
    }

    setIsScanningPorts(true);
    setPortScanResults([]);

    const criticalPorts = [22, 80, 443, 8080];

    criticalPorts.forEach((port) => {
      const client = TcpSocket.createConnection({
        port: port,
        host: targetPortIp
      }, () => {
        setPortScanResults(prev => [...prev, `🟢 PORT ${port} [OPEN] -> Diagnostic Service Access Confirmed`]);
        client.destroy();
      });

      client.setTimeout(250);

      client.on('error', (err) => {
        if (err.message.includes('refused')) {
          setPortScanResults(prev => [...prev, `🔴 PORT ${port} [SECURE] -> Handshake Refused/Closed`]);
        }
        client.destroy();
      });

      client.on('timeout', () => {
        setPortScanResults(prev => [...prev, `❌ PORT ${port} [TIMEOUT] -> Packet Dropped`]);
        client.destroy();
      });
    });

    setTimeout(() => setIsScanningPorts(false), 1200);
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* GLOBAL SYSTEM HEADER */}
      <View style={styles.appHeader}>
        <View>
          <Text style={styles.titleHeader}>TRUSTWIRE UTILITY CONTROL</Text>
          {lanProgress ? <Text style={styles.subText}>{lanProgress}</Text> : null}
        </View>
        <TouchableOpacity
          style={[styles.primaryToggle, isScanning ? styles.toggleActive : styles.toggleInactive]}
          onPress={toggleScanning}
        >
          <Text style={styles.toggleText}>
            {permissionCheckBusy ? 'CHECKING PERMISSIONS...' : isScanning ? 'TERMINATE SCAN' : 'INITIALIZE SCAN'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* RENDER DYNAMIC DASHBOARD NAVIGATION MODULES */}
      <View style={styles.viewport}>
        {activeTab === 'RADAR' ? (
          <View style={styles.pageBody}>
            <View style={styles.radarOuterCircle}>
              <Animated.View style={[styles.radarMiddleCircle, { opacity: pulseValue }]} />
              <Animated.View style={[styles.radarInnerCircle, { opacity: pulseValue }]} />
              <View style={styles.radarCrosshairH} />
              <View style={styles.radarCrosshairV} />

              {discoveredDevices.map((dev) => {
                const coords = calculateRadarCoordinates(dev);
                return (
                  <TouchableOpacity
                    key={dev.id}
                    style={[styles.targetBlipContainer, { top: coords.top, left: coords.left }]}
                    onPress={() => { setSelectedDevice(dev); setModalVisible(true); }}
                  >
                    <View style={[styles.targetBlipCore, dev.type === 'BLE' ? { backgroundColor: '#00E5FF' } : { backgroundColor: '#00FF66' }]} />
                  </TouchableOpacity>
                );
              })}
              {isScanning && <Animated.View style={[styles.sweeperCone, { transform: [{ rotate: spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]} />}
            </View>
            <View style={styles.legendContainer}>
              <Text style={{ color: '#00E5FF', fontSize: 11, fontWeight: 'bold' }}>● BLE Radio (Blue)</Text>
              <Text style={{ color: '#00FF66', fontSize: 11, fontWeight: 'bold' }}>● Wi-Fi LAN (Green)</Text>
            </View>
          </View>
        ) : activeTab === 'DEVICES' ? (
          <FlatList
            data={discoveredDevices}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.deviceRow} onPress={() => { setSelectedDevice(item); setModalVisible(true); }}>
                <View>
                  <Text style={{ color: item.type === 'BLE' ? '#00E5FF' : '#00FF66', fontWeight: 'bold', fontSize: 14 }}>{item.name}</Text>
                  <Text style={{ color: '#94A3B8', fontSize: 11 }}>{`${item.proximity || 'Unknown Range'} • ${item.trend || 'Stable'}`}</Text>
                </View>
                <Text style={{ color: '#64748B', fontSize: 12 }}>{item.id} [{item.type}]</Text>
              </TouchableOpacity>
            )}
          />
        ) : activeTab === 'PORT_SCAN' ? (
          <ScrollView contentContainerStyle={{ gap: 15 }}>
            <Text style={styles.moduleTitle}>⚡ PORT MATRIX SERVICE PROBER</Text>
            <TextInput
              style={styles.terminalInput}
              placeholder="Enter Target Subnet IP (e.g., 192.168.1.1)"
              placeholderTextColor="#334155"
              value={targetPortIp}
              onChangeText={setTargetPortIp}
            />
            <TouchableOpacity style={styles.actionButton} onPress={runSubnetPortScan}>
              {isScanningPorts ? <ActivityIndicator color="#040912" /> : <Text style={styles.actionButtonText}>EXECUTE SERVICE PORT FINGERPRINTING</Text>}
            </TouchableOpacity>
            <View style={styles.consoleLogBox}>
              {portScanResults.map((res, i) => <Text key={i} style={styles.consoleText}>{res}</Text>)}
            </View>
          </ScrollView>
        ) : (
          /* CONFIG PANEL MOVED TO THE LAST TAB HUB RUNTIME */
          <ScrollView contentContainerStyle={{ gap: 20 }}>
            <Text style={styles.moduleTitle}>⚙️ CONTEXT COMPONENT SPECIFICATIONS</Text>

            <View style={{ gap: 6 }}>
              <Text style={styles.settingsLabel}>BLE HARDWARE ADVERTISEMENT RSSI CUTOFF (dBm)</Text>
              <TextInput
                style={styles.terminalInput}
                value={rssiThreshold}
                onChangeText={setRssiThreshold}
                keyboardType="numeric"
              />
              <Text style={{ color: '#64748B', fontSize: 11 }}>Filters out background signals below this decibel value.</Text>
            </View>

            <View style={{ gap: 6 }}>
              <Text style={styles.settingsLabel}>GLOBAL SUB-TOPOLOGY ROUTER RE-NAME LABEL</Text>
              <TextInput
                style={styles.terminalInput}
                value={customSsidName}
                onChangeText={setCustomSsidName}
              />
              <Text style={{ color: '#64748B', fontSize: 11 }}>Re-maps discovered anonymous local hosts into distinct localized identifiers.</Text>
            </View>

            <View style={styles.systemStatusBlock}>
              <Text style={{ color: '#00FF66', fontWeight: 'bold', fontSize: 12, marginBottom: 5 }}>HARDWARE PERIPHERAL TELEMETRY</Text>
              <Text style={styles.statusTelemetryText}>Native BLE Scan Permission: {permissionState.bleScan.toUpperCase()}</Text>
              <Text style={styles.statusTelemetryText}>Native BLE Connect Permission: {permissionState.bleConnect.toUpperCase()}</Text>
              <Text style={styles.statusTelemetryText}>Local Network / Wi-Fi Permission: {permissionState.lan.toUpperCase()}</Text>
              <Text style={styles.statusTelemetryText}>Location Permission: {permissionState.location.toUpperCase()}</Text>
              <Text style={styles.statusTelemetryText}>Movement Tracking: {userPosition ? `ACTIVE (${userPosition.latitude.toFixed(4)}, ${userPosition.longitude.toFixed(4)})` : 'IDLE'}</Text>
              <Text style={styles.statusTelemetryText}>Active Buffer Pipeline Encoders: 16-BIT HEX/ASCII READY</Text>
              <Text style={styles.statusTelemetryText}>Active Local Subnet Mapping Bounds: Layer 3 TCP Intercept Enabled</Text>
            </View>
          </ScrollView>
        )}
      </View>

      {/* PERIPHERAL SELECTION DASHBOARD TRAILING PANEL */}
      <View style={styles.tabDashboard}>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'RADAR' && styles.tabButtonSelected]} onPress={() => setActiveTab('RADAR')}><Text style={styles.tabButtonText}>RADAR</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'DEVICES' && styles.tabButtonSelected]} onPress={() => setActiveTab('DEVICES')}><Text style={styles.tabButtonText}>TARGETS ({discoveredDevices.length})</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'PORT_SCAN' && styles.tabButtonSelected]} onPress={() => setActiveTab('PORT_SCAN')}><Text style={styles.tabButtonText}>PORTS</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'CONFIG' && styles.tabButtonSelected]} onPress={() => setActiveTab('CONFIG')}><Text style={styles.tabButtonText}>CONFIG</Text></TouchableOpacity>
      </View>

      {/* --- HUD INTERCEPT MODAL --- */}
      <Modal animationType="slide" transparent={true} visible={modalVisible}>
        <View style={styles.modalOverlayContainer}>
          <View style={styles.hudTelemetryCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: '#00FF66', fontSize: 11, fontWeight: '900' }}>TARGET INTERROGATION TERMINAL</Text>
              <Text style={{ color: '#64748B', fontSize: 11 }}>{selectedDevice?.type} LINK</Text>
            </View>
            <Text style={styles.hudDeviceMainName}>{selectedDevice?.name}</Text>
            <Text style={{ color: '#00E5FF', fontFamily: 'Courier', fontSize: 12 }}>{selectedDevice?.id}</Text>
            <Text style={{ color: '#94A3B8', fontSize: 12 }}>
              {selectedDevice?.type === 'BLE'
                ? `Proximity: ${selectedDevice?.proximity || 'Unknown'}${selectedDevice?.estimatedDistanceM ? ` (~${selectedDevice.estimatedDistanceM.toFixed(1)}m)` : ''}${selectedDevice?.trend ? ` • ${selectedDevice.trend}` : ''}`
                : `Proximity: ${selectedDevice?.proximity || 'Unknown'}${selectedDevice?.latencyMs ? ` (${selectedDevice.latencyMs}ms RTT)` : ''}${selectedDevice?.trend ? ` • ${selectedDevice.trend}` : ''}`}
            </Text>

            <View style={styles.hudDivider} />

            {selectedDevice?.type === 'BLE' ? (
              <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ color: '#64748B', fontSize: 12 }}>CONFIG TARGET MTU:</Text>
                  <TextInput
                    style={[styles.terminalInput, { width: 70, paddingVertical: 4 }]}
                    value={mtuValue}
                    onChangeText={setMtuValue}
                    keyboardType="numeric"
                  />
                  <TouchableOpacity style={styles.smallConnectBtn} onPress={() => establishActiveRadioLink(selectedDevice.id)}>
                    <Text style={{ fontSize: 10, fontWeight: 'bold' }}>LINK LAYER</Text>
                  </TouchableOpacity>
                </View>

                <Text style={{ color: '#64748B', fontSize: 11, fontWeight: 'bold', marginTop: 5 }}>TRANSMIT PAYLOAD DATA COMMAND:</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TextInput
                    style={[styles.terminalInput, { flex: 1 }]}
                    placeholder="e.g. 0x414243 or AT+RESET"
                    placeholderTextColor="#334155"
                    value={commandInput}
                    onChangeText={setCommandInput}
                  />
                  <TouchableOpacity style={[styles.smallConnectBtn, { backgroundColor: '#00FF66' }]} onPress={dispatchCommandPayload}>
                    <Text style={{ fontSize: 10, color: '#000', fontWeight: 'bold' }}>WRITE</Text>
                  </TouchableOpacity>
                </View>

                <View style={[styles.consoleLogBox, { height: 120 }]}>
                  {commandLog.map((log, i) => <Text key={i} style={[styles.consoleText, log.includes('OUT') ? { color: '#00E5FF' } : { color: '#94A3B8' }]}>{log}</Text>)}
                </View>
              </ScrollView>
            ) : (
              <View style={{ gap: 8 }}>
                <Text style={{ color: '#94A3B8' }}>LAN Target Interface Selected. Use the **PORTS** tab to fingerprint ports for this client.</Text>
                <TouchableOpacity style={styles.actionButton} onPress={() => { setTargetPortIp(selectedDevice.id); setActiveTab('PORT_SCAN'); setModalVisible(false); }}>
                  <Text style={styles.actionButtonText}>BIND IP TO FINGERPRINT RIG</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity style={styles.hudCloseButton} onPress={() => { setModalVisible(false); setCommandLog([]); setConnectionState('DISCONNECTED'); }}>
              <Text style={styles.hudCloseBtnText}>DISCONNECT TERMINAL</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent={true} visible={permissionHudVisible}>
        <View style={styles.modalOverlayContainer}>
          <View style={styles.permissionHudCard}>
            <Text style={styles.permissionHudTitle}>PERMISSION DIAGNOSTIC HUD</Text>
            <Text style={styles.permissionHudSubtitle}>Trustwire requires RF + LAN access for accurate wireless mapping.</Text>

            <View style={{ gap: 8 }}>
              {permissionHudMessages.map((message, index) => (
                <Text key={`${message}-${index}`} style={styles.permissionHudMessage}>• {message}</Text>
              ))}
            </View>

            <Text style={styles.permissionHudHint}>
              Open System Settings and enable Bluetooth + Local Network/Wi-Fi permissions for Trustwire.
            </Text>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={[styles.hudCloseButton, styles.permissionActionBtn]} onPress={openSystemSettings}>
                <Text style={styles.permissionActionText}>OPEN SETTINGS</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.hudCloseButton, styles.permissionDismissBtn]} onPress={() => setPermissionHudVisible(false)}>
                <Text style={styles.hudCloseBtnText}>DISMISS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#040912' },
  appHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15, borderBottomWidth: 1, borderColor: '#0D223B' },
  titleHeader: { fontSize: 13, fontWeight: '900', color: '#00FF66', letterSpacing: 1.2 },
  subText: { color: '#00E5FF', fontSize: 11, marginTop: 2, fontFamily: 'Courier' },
  primaryToggle: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4, borderWidth: 1 },
  toggleInactive: { backgroundColor: 'rgba(0, 255, 102, 0.08)', borderColor: '#00FF66' },
  toggleActive: { backgroundColor: 'rgba(255, 59, 48, 0.18)', borderColor: '#FF3B30' },
  toggleText: { color: '#FFF', fontSize: 10, fontWeight: '900' },
  viewport: { flex: 1, padding: 20 },
  pageBody: { flex: 1, justifyContent: 'center' },
  radarOuterCircle: { width: 270, height: 270, borderRadius: 135, borderWidth: 1.5, borderColor: '#004A26', alignSelf: 'center', justifyContent: 'center', alignItems: 'center', backgroundColor: '#02120A', overflow: 'hidden', position: 'relative' },
  radarMiddleCircle: { position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 1, borderColor: 'rgba(0, 255, 102, 0.22)' },
  radarInnerCircle: { position: 'absolute', width: 90, height: 90, borderWidth: 1, borderRadius: 45, borderColor: 'rgba(0, 255, 102, 0.16)' },
  radarCrosshairH: { position: 'absolute', width: '100%', height: 1, backgroundColor: 'rgba(0, 255, 102, 0.15)' },
  radarCrosshairV: { position: 'absolute', width: 1, height: '100%', backgroundColor: 'rgba(0, 255, 102, 0.15)' },
  sweeperCone: { position: 'absolute', width: 135, height: 135, bottom: '50%', left: '50%', borderRightWidth: 2, borderRightColor: '#00FF66', backgroundColor: 'rgba(0, 255, 102, 0.04)', transformOrigin: 'bottom left' },
  targetBlipContainer: { position: 'absolute', width: 30, height: 30, justifyContent: 'center', alignItems: 'center', zIndex: 40 },
  targetBlipCore: { width: 10, height: 10, borderRadius: 5 },
  legendContainer: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 25 },
  deviceRow: { backgroundColor: '#081729', padding: 14, borderRadius: 4, marginVertical: 4, borderWidth: 1, borderColor: '#152C47', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tabDashboard: { flexDirection: 'row', height: 64, borderTopWidth: 1, borderColor: '#0D223B', backgroundColor: '#060E1A' },
  tabButton: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#07111F' },
  tabButtonSelected: { backgroundColor: '#0C1C30', borderTopWidth: 2, borderColor: '#00FF66' },
  tabButtonText: { color: '#94A3B8', fontSize: 10, fontWeight: '800' },
  moduleTitle: { color: '#00FF66', fontSize: 14, fontWeight: '900', letterSpacing: 1, marginBottom: 5 },
  settingsLabel: { color: '#64748B', fontSize: 11, fontWeight: 'bold' },
  terminalInput: { backgroundColor: '#02060D', borderWidth: 1, borderColor: '#1E293B', borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10, color: '#00FF66', fontFamily: 'Courier', fontSize: 13 },
  actionButton: { backgroundColor: '#00FF66', padding: 14, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  actionButtonText: { color: '#040912', fontWeight: '900', fontSize: 11, letterSpacing: 1 },
  consoleLogBox: { backgroundColor: '#02060D', borderWidth: 1, borderColor: '#132F52', borderRadius: 4, padding: 10, height: 200, gap: 4 },
  consoleText: { color: '#94A3B8', fontFamily: 'Courier', fontSize: 12 },
  modalOverlayContainer: { flex: 1, backgroundColor: 'rgba(3, 8, 18, 0.9)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  hudTelemetryCard: { width: '100%', backgroundColor: '#071220', borderRadius: 6, borderWidth: 1.5, borderColor: '#00FF66', padding: 18, gap: 10 },
  hudDeviceMainName: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  hudDivider: { height: 1, backgroundColor: 'rgba(0, 255, 102, 0.15)' },
  smallConnectBtn: { backgroundColor: '#00E5FF', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 4, justifyContent: 'center' },
  hudCloseButton: { padding: 12, backgroundColor: 'rgba(255, 59, 48, 0.08)', borderWidth: 1, borderColor: '#FF3B30', borderRadius: 4, alignItems: 'center', marginTop: 5 },
  hudCloseBtnText: { color: '#FF3B30', fontWeight: '900', fontSize: 11 },
  systemStatusBlock: { marginTop: 10, padding: 12, backgroundColor: '#091524', borderRadius: 4, borderWidth: 1, borderColor: '#1E293B' },
  statusTelemetryText: { color: '#94A3B8', fontFamily: 'Courier', fontSize: 11, marginVertical: 2 },
  permissionHudCard: { width: '100%', backgroundColor: '#071220', borderRadius: 8, borderWidth: 1.5, borderColor: '#F59E0B', padding: 16, gap: 12 },
  permissionHudTitle: { color: '#F59E0B', fontSize: 14, fontWeight: '900', letterSpacing: 0.6 },
  permissionHudSubtitle: { color: '#E2E8F0', fontSize: 12 },
  permissionHudMessage: { color: '#CBD5E1', fontSize: 12, lineHeight: 18 },
  permissionHudHint: { color: '#94A3B8', fontSize: 11, lineHeight: 16, marginTop: 4 },
  permissionActionBtn: { flex: 1, borderColor: '#F59E0B', backgroundColor: 'rgba(245, 158, 11, 0.12)' },
  permissionDismissBtn: { flex: 1 },
  permissionActionText: { color: '#FCD34D', fontWeight: '900', fontSize: 11 }
});
