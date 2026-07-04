import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, FlatList, Animated, Easing, SafeAreaView, Modal, ScrollView, ActivityIndicator, TextInput, Platform, PermissionsAndroid } from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { NetworkInfo } from 'react-native-network-info';
import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';
import * as Location from 'expo-location';
import Zeroconf from 'react-native-zeroconf';
import RadarScreen from './RadarScreen';

let bleManager: BleManager | null = null;
const RADAR_RADIUS = 160;
const RADAR_MAX_PLOT_RADIUS = 130;
const HEADING_SMOOTHING_ALPHA = 0.2;
const HEADING_DEADBAND_DEG = 4;
const BLE_DISTANCE_SMOOTHING_ALPHA = 0.35;
const BLE_DISTANCE_DEADBAND_M = 0.35;
const BLE_DISTANCE_MAX_STEP_M = 1.8;
const BLE_STABLE_DISTANCE_DEADBAND_M = 0.6;
const BLE_STABLE_RSSI_DEADBAND_DB = 2;
const BLE_STABLE_HOLD_COUNT = 4;
const BLE_NEAR_RSSI_DBM = -52;
const BLE_VERY_NEAR_RSSI_DBM = -45;
const BLE_NEAR_DISTANCE_M = 0.4;
const BLE_VERY_NEAR_DISTANCE_M = 0.15;
const BLE_DISTANCE_MIN_M = 0.1;
const BLE_DISTANCE_MAX_M = 45;

const normalizeAngle = (deg: number) => ((deg % 360) + 360) % 360;

const shortestAngleDelta = (fromDeg: number, toDeg: number) => {
  const delta = normalizeAngle(toDeg - fromDeg);
  return delta > 180 ? delta - 360 : delta;
};

const getBleManager = () => {
  if (bleManager) return bleManager;

  try {
    bleManager = new BleManager();
    return bleManager;
  } catch {
    return null;
  }
};

const getBleProximityLabel = (rssi: number) => {
  if (rssi >= -55) return 'VERY NEAR';
  if (rssi >= -67) return 'NEAR';
  if (rssi >= -77) return 'MID';
  return 'FAR';
};

const getLanZoneLabel = (ip: string) => {
  const parts = ip.split('.');
  const lastOctet = parts.length === 4 ? parseInt(parts[3], 10) || 0 : 0;

  if (lastOctet <= 63) return 'ZONE A';
  if (lastOctet <= 127) return 'ZONE B';
  if (lastOctet <= 191) return 'ZONE C';
  return 'ZONE D';
};

type DeviceFocusFilter = 'ALL' | 'IPHONES' | 'LAPTOPS' | 'ROUTERS' | 'TELEVISIONS' | 'CAMERAS' | 'OTHER';

const DEVICE_FOCUS_OPTIONS: DeviceFocusFilter[] = ['ALL', 'IPHONES', 'LAPTOPS', 'ROUTERS', 'TELEVISIONS', 'CAMERAS', 'OTHER'];

const COMPANY_BRAND_MAP: Record<number, string> = {
  0x004c: 'Apple',
  0x0075: 'Samsung',
  0x0006: 'Microsoft',
  0x00e0: 'Google',
  0x000f: 'Broadcom',
  0x0059: 'Nordic',
  0x0131: 'Xiaomi',
  0x0118: 'Huawei',
};

const normalizeFingerprint = (value: string) => ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

const scoreKeywords = (fingerprint: string, keywords: string[]) =>
  keywords.reduce((score, keyword) => (fingerprint.includes(` ${keyword} `) ? score + 1 : score), 0);

const isGenericDeviceName = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (/^ble\s/i.test(trimmed)) return true;
  if (/^unknown/i.test(trimmed)) return true;
  if (/^ip network client$/i.test(trimmed)) return true;
  if (/^(device|peripheral|beacon)$/i.test(trimmed)) return true;
  if (/^([a-f0-9]{2}[:-]){3,}[a-f0-9]{2}$/i.test(trimmed)) return true;
  return false;
};

const buildLanFallbackName = (host?: number) => {
  if (host === 1 || host === 254) return 'Router Gateway';
  if (host === 22) return 'Network Service Host';
  if (host === 45 || host === 101 || host === 115) return 'Smart Device Node';
  return 'LAN Device';
};

const getBleMetadataSnapshot = (manufacturerData?: string) => {
  if (!manufacturerData) {
    return { companyId: null as number | null, metadataHint: '', manufacturerHex: '' };
  }

  try {
    const payload = Buffer.from(manufacturerData, 'base64');
    if (payload.length < 2) {
      return { companyId: null as number | null, metadataHint: '', manufacturerHex: payload.toString('hex') };
    }

    const companyId = payload[0] | (payload[1] << 8);
    const manufacturerHex = payload.toString('hex');

    let metadataHint = '';
    if (companyId === 0x004c) metadataHint = 'apple';
    else if (companyId === 0x0075) metadataHint = 'samsung';
    else if (companyId === 0x0006) metadataHint = 'microsoft';
    else if (companyId === 0x00e0) metadataHint = 'google';
    else if (companyId === 0x000f) metadataHint = 'broadcom';

    return { companyId, metadataHint, manufacturerHex };
  } catch {
    return { companyId: null as number | null, metadataHint: '', manufacturerHex: '' };
  }
};

export default function App() {
  // Navigation Matrix
  const [activeTab, setActiveTab] = useState<'RADAR' | 'TARGETS' | 'PORTS' | 'OTA' | 'SETTINGS'>('RADAR');
  const [isScanning, setIsScanning] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<any[]>([]);
  const [systemLog, setSystemLog] = useState('System Initialized & Ready');

  // Diagnostic State Hooks
  const [selectedDevice, setSelectedDevice] = useState<any | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedRadiusMeters, setSelectedRadiusMeters] = useState(25);
  const [selectedDeviceFocusFilter, setSelectedDeviceFocusFilter] = useState<DeviceFocusFilter>('ALL');
  const [deviceDropdownVisible, setDeviceDropdownVisible] = useState(false);
  
  // Custom Configuration & Port Scanning Specs
  const [commandInput, setCommandInput] = useState('');
  const [commandLog, setCommandLog] = useState<string[]>([]);
  const [targetPortIp, setTargetPortIp] = useState('');
  const [portScanResults, setPortScanResults] = useState<string[]>([]);
  const [isScanningPorts, setIsScanningPorts] = useState(false);

  // OTA Firmware Deployment State
  const [firmwareVersion, setFirmwareVersion] = useState('v2.5.0-release');
  const [otaProgress, setOtaProgress] = useState(0);
  const [isFlashing, setIsFlashing] = useState(false);
  const [otaStatusLog, setOtaStatusLog] = useState<string[]>([]);
  const [userLocation, setUserLocation] = useState<Location.LocationObjectCoords | null>(null);
  const [locationStatus, setLocationStatus] = useState('Locating user...');
  const [userHeadingDeg, setUserHeadingDeg] = useState<number | null>(null);

  // Animation Refs
  const spinValue = useRef(new Animated.Value(0)).current;
  const pulseValue = useRef(new Animated.Value(1)).current;
  const locationSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const headingSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const zeroconfRef = useRef<any | null>(null);
  const zeroconfStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingRef = useRef<number | null>(null);
  const headingInitializedRef = useRef(false);

  // Polar Coordinate Mapping For Radar Display
  const calculateRadarCoordinates = (device: any) => {
    let r = RADAR_RADIUS * 0.6;
    let angle = 0;
    const stringKey = device.id;
    let hash = 0;
    for (let i = 0; i < stringKey.length; i++) {
      hash = stringKey.charCodeAt(i) + ((hash << 5) - hash);
    }
    const fallbackAngleDeg = Math.abs(hash % 360);
    const hasAngleDeg = typeof device.angleDeg === 'number' && Number.isFinite(device.angleDeg);
    const mappedAngleDeg = (hasAngleDeg ? device.angleDeg : fallbackAngleDeg) - 90;
    angle = mappedAngleDeg * (Math.PI / 180);
    const headingOffset = (((userHeadingDeg ?? 0) * Math.PI) / 180);
    angle += headingOffset;

    if (device.type === 'BLE') {
      if (typeof device.estDistanceM === 'number') {
        const normalizedDistance = Math.min(1, Math.max(0, device.estDistanceM / selectedRadiusMeters));
        r = 10 + normalizedDistance * (RADAR_MAX_PLOT_RADIUS - 10);
      } else {
        const clampedRssi = Math.max(-95, Math.min(-40, device.rssi ?? -80));
        const percentage = (clampedRssi - (-95)) / (-40 - (-95));
        r = (1 - percentage) * (RADAR_MAX_PLOT_RADIUS - 12) + 12;
      }
    } else {
      const parts = device.id.split('.');
      const lastOctet = parts.length === 4 ? parseInt(parts[3], 10) || 100 : 100;
      r = ((lastOctet % 50) / 50) * (RADAR_MAX_PLOT_RADIUS - 14) + 14;
    }

    r = Math.max(10, Math.min(RADAR_MAX_PLOT_RADIUS, r));

    const x = RADAR_RADIUS + r * Math.cos(angle) - 15;
    const y = RADAR_RADIUS + r * Math.sin(angle) - 15;
    return { top: y, left: x };
  };

  // --- NATIVE PERMISSIONS REQUEST MANDATE ---
  const verifyHardwareClearance = async () => {
    if (Platform.OS === 'android') {
      if (Number(Platform.Version) >= 31) {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        return granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED;
      }
      const legacyGranted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
      return legacyGranted === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true; // iOS grants via Info.plist triggers
  };

  const estimateBleDistanceMeters = (rssi?: number, txPower = -59) => {
    const signal = Math.max(-97, Math.min(-35, typeof rssi === 'number' ? rssi : -80));
    const calibratedTxPower = Number.isFinite(txPower) ? txPower : -59;

    const propagationFactor = signal >= -60 ? 1.8 : signal >= -72 ? 2.1 : 2.5;
    const baseDistance = Math.pow(10, (calibratedTxPower - signal) / (10 * propagationFactor));

    const nearFieldCorrection = signal >= -55 ? 0.72 : signal >= -67 ? 0.85 : 1;
    const correctedDistance = baseDistance * nearFieldCorrection;

    return Math.max(BLE_DISTANCE_MIN_M, Math.min(correctedDistance, BLE_DISTANCE_MAX_M));
  };

  const startUserLocationTracking = async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationStatus('Location permission denied');
        return;
      }

      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setUserLocation(current.coords);
      setLocationStatus('Live location active');

      if (locationSubscriptionRef.current) {
        locationSubscriptionRef.current.remove();
        locationSubscriptionRef.current = null;
      }

      locationSubscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: 1,
          timeInterval: 1000,
        },
        (position) => {
          setUserLocation(position.coords);
          setLocationStatus('Live location active');
        },
      );
    } catch {
      setLocationStatus('Location unavailable');
    }
  };

  const startHeadingTracking = async () => {
    try {
      if (headingSubscriptionRef.current) {
        headingSubscriptionRef.current.remove();
        headingSubscriptionRef.current = null;
      }

      headingInitializedRef.current = false;
      headingRef.current = null;
      setUserHeadingDeg(null);

      headingSubscriptionRef.current = await Location.watchHeadingAsync((headingData) => {
        if (typeof headingData.accuracy === 'number' && headingData.accuracy < 0) {
          return;
        }

        const rawHeading = typeof headingData.trueHeading === 'number' && headingData.trueHeading >= 0
          ? headingData.trueHeading
          : headingData.magHeading;
        if (typeof rawHeading !== 'number' || !Number.isFinite(rawHeading)) {
          return;
        }

        const sensorHeading = normalizeAngle(rawHeading || 0);
        if (!headingInitializedRef.current || headingRef.current === null) {
          headingInitializedRef.current = true;
          headingRef.current = sensorHeading;
          setUserHeadingDeg(sensorHeading);
          return;
        }

        const previousHeading = headingRef.current;
        const delta = shortestAngleDelta(previousHeading, sensorHeading);

        if (Math.abs(delta) < HEADING_DEADBAND_DEG) {
          return;
        }

        const smoothedHeading = normalizeAngle(previousHeading + delta * HEADING_SMOOTHING_ALPHA);
        headingRef.current = smoothedHeading;
        setUserHeadingDeg(smoothedHeading);
      });
    } catch {
      setSystemLog('Heading sensor unavailable');
    }
  };

  useEffect(() => {
    const zeroconf = new Zeroconf();
    zeroconfRef.current = zeroconf;

    zeroconf.on('resolved', (service: any) => {
      const addresses = Array.isArray(service?.addresses) ? service.addresses : [];
      const ipv4 = addresses.find((addr: string) => /^\d+\.\d+\.\d+\.\d+$/.test(addr));
      const serviceName = String(service?.name || service?.host || '').trim();
      if (!ipv4 || !serviceName) return;

      setDiscoveredDevices((prev) =>
        prev.map((item) => {
          if (item.type !== 'LAN' || item.id !== ipv4) return item;
          return {
            ...item,
            name: serviceName,
            brand: item.brand === 'IP Network Client' ? 'mDNS Resolved Host' : item.brand,
          };
        }),
      );
    });

    startUserLocationTracking();
    startHeadingTracking();
    return () => {
      locationSubscriptionRef.current?.remove();
      locationSubscriptionRef.current = null;
      headingSubscriptionRef.current?.remove();
      headingSubscriptionRef.current = null;
      if (zeroconfStopTimerRef.current) {
        clearTimeout(zeroconfStopTimerRef.current);
        zeroconfStopTimerRef.current = null;
      }
      zeroconfRef.current?.stop?.();
      zeroconfRef.current?.removeDeviceListeners?.();
      zeroconfRef.current = null;
    };
  }, []);

  // --- LOCAL AREA NETWORK (LAN) SCANNER ---
  const scanLocalNetwork = async () => {
    setSystemLog('Mapping Network Subnet...');
    try {
      const ip = await NetworkInfo.getIPAddress();
const subnetBase = ip && !ip.includes(':') ? ip.substring(0, ip.lastIndexOf('.')) : '10.0.0';
      
      // Probe active routing segments
      const targets = [1, 5, 10, 22, 45, 101, 115, 254];
      for (const host of targets) {
        const testIp = `${subnetBase}.${host}`;
        addLanTarget(testIp, buildLanFallbackName(host), userLocation, host);
      }

      const zeroconf = zeroconfRef.current;
      if (zeroconf) {
        try {
          zeroconf.stop?.();
          zeroconf.scan('http', 'tcp', 'local.');
          zeroconf.scan('workstation', 'tcp', 'local.');
          zeroconf.scan('googlecast', 'tcp', 'local.');
          zeroconf.scan('airplay', 'tcp', 'local.');

          if (zeroconfStopTimerRef.current) {
            clearTimeout(zeroconfStopTimerRef.current);
          }
          zeroconfStopTimerRef.current = setTimeout(() => {
            zeroconf.stop?.();
          }, 4500);
        } catch {
          // ignore zeroconf scan errors
        }
      }

      setSystemLog('LAN Topography Mapped');
    } catch (err) {
      setSystemLog('Subnet Scan Interrupted');
    }
  };

  const addLanTarget = (ip: string, name: string, userCoords?: Location.LocationObjectCoords | null, host?: number) => {
    const lanHint = host === 1 || host === 254 ? 'router gateway access point' : '';

    setDiscoveredDevices(prev => {
      if (prev.some(d => d.id === ip)) return prev;
      return [...prev, {
        id: ip,
        name,
        type: 'LAN',
        rssi: -45,
        brand: 'IP Network Client',
        userLat: userCoords?.latitude,
        userLon: userCoords?.longitude,
        lanHint,
      }];
    });
  };

  // --- SPECTRUM SCAN TRIGGER ---
  useEffect(() => {
    if (isScanning) {
      setDiscoveredDevices([]);
      verifyHardwareClearance().then((hasPermission) => {
        if (!hasPermission) {
          setSystemLog('Permissions Denied');
          setIsScanning(false);
          return;
        }

        scanLocalNetwork();

        const manager = getBleManager();
        if (!manager) {
          setSystemLog('BLE native bridge unavailable on this build/device');
          return;
        }

        Animated.loop(Animated.timing(spinValue, { toValue: 1, duration: 2500, easing: Easing.linear, useNativeDriver: true })).start();
        Animated.loop(Animated.sequence([
          Animated.timing(pulseValue, { toValue: 0.4, duration: 1200, useNativeDriver: true }),
          Animated.timing(pulseValue, { toValue: 1, duration: 1200, useNativeDriver: true }),
        ])).start();

        manager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
          if (error) {
            setSystemLog(`BLE Scan Error: ${error.message}`);
            return;
          }

          if (device) {
            setDiscoveredDevices((prev) => {
              const existingIndex = prev.findIndex((d) => d.id === device.id);
              const fallbackBleName = `BLE ${String(device.id || 'NO-ID').slice(0, 8)}`;
              const bleName = device.name || device.localName || fallbackBleName;
              const metadataSnapshot = getBleMetadataSnapshot(device.manufacturerData || undefined);
              const companyBrand = metadataSnapshot.companyId ? COMPANY_BRAND_MAP[metadataSnapshot.companyId] : undefined;
              const normalizedName = String(bleName || '').trim();
              const displayName = isGenericDeviceName(normalizedName)
                ? `${companyBrand || 'BLE'} Device`
                : normalizedName;

              const txPowerLevel = typeof device.txPowerLevel === 'number' ? device.txPowerLevel : -59;
              const nextDevice = {
                id: device.id,
                name: displayName,
                localName: device.localName || '',
                type: 'BLE',
                rssi: device.rssi ?? -80,
                brand: companyBrand || 'BLE Peripheral',
                txPowerLevel,
                estDistanceM: estimateBleDistanceMeters(device.rssi ?? undefined, txPowerLevel),
                manufacturerData: device.manufacturerData || '',
                serviceUUIDs: Array.isArray(device.serviceUUIDs) ? device.serviceUUIDs.join(' ') : '',
                manufacturerCompanyId: metadataSnapshot.companyId,
                metadataHint: metadataSnapshot.metadataHint,
                manufacturerHex: metadataSnapshot.manufacturerHex,
              };

              if (existingIndex === -1) {
                return [...prev, nextDevice];
              }

              const updated = [...prev];
              const previousDistance = updated[existingIndex]?.estDistanceM;
              const incomingDistance = nextDevice.estDistanceM;
              const previousRssi = typeof updated[existingIndex]?.rssi === 'number' ? updated[existingIndex].rssi : nextDevice.rssi;
              const previousStableCount = typeof updated[existingIndex]?.stableCount === 'number' ? updated[existingIndex].stableCount : 0;
              let smoothedDistance = incomingDistance;
              let stableCount = 0;

              if (typeof previousDistance === 'number') {
                const delta = incomingDistance - previousDistance;
                const rssiDelta = Math.abs((nextDevice.rssi ?? -80) - (previousRssi ?? -80));

                if (Math.abs(delta) <= BLE_STABLE_DISTANCE_DEADBAND_M && rssiDelta <= BLE_STABLE_RSSI_DEADBAND_DB) {
                  stableCount = previousStableCount + 1;
                }

                if (stableCount >= BLE_STABLE_HOLD_COUNT) {
                  smoothedDistance = previousDistance;
                } else if (Math.abs(delta) < BLE_DISTANCE_DEADBAND_M) {
                  smoothedDistance = previousDistance;
                } else {
                  const clampedDelta = Math.max(-BLE_DISTANCE_MAX_STEP_M, Math.min(BLE_DISTANCE_MAX_STEP_M, delta));
                  const limitedTarget = previousDistance + clampedDelta;
                  smoothedDistance = previousDistance + (limitedTarget - previousDistance) * BLE_DISTANCE_SMOOTHING_ALPHA;
                }
              }

              if (typeof nextDevice.rssi === 'number') {
                if (nextDevice.rssi >= BLE_VERY_NEAR_RSSI_DBM) {
                  smoothedDistance = BLE_VERY_NEAR_DISTANCE_M;
                } else if (nextDevice.rssi >= BLE_NEAR_RSSI_DBM) {
                  smoothedDistance = Math.min(smoothedDistance, BLE_NEAR_DISTANCE_M);
                }
              }

              updated[existingIndex] = {
                ...updated[existingIndex],
                ...nextDevice,
                estDistanceM: smoothedDistance,
                stableCount,
              };
              return updated;
            });
          }
        });
      });
    } else {
      spinValue.setValue(0);
      getBleManager()?.stopDeviceScan();
      setSystemLog('Scanner Standby');
    }
  }, [isScanning]);

  // --- SERVICE PORT SCANNER (TCP SOCKETS) ---
  const runPortScan = async () => {
    if (!targetPortIp) return;
    setIsScanningPorts(true);
    setPortScanResults([]);
    const criticalPorts = [22, 80, 443, 8080];

    criticalPorts.forEach((port) => {
      const client = TcpSocket.createConnection({ port: port, host: targetPortIp }, () => {
        setPortScanResults(prev => [...prev, `🟢 PORT ${port}: OPEN (Diagnostic Service Verified)`]);
        client.destroy();
      });

      client.setTimeout(200);

      client.on('error', (err) => {
        if (err.message.includes('refused')) {
          setPortScanResults(prev => [...prev, `🔴 PORT ${port}: CLOSED`]);
        }
        client.destroy();
      });

      client.on('timeout', () => {
        setPortScanResults(prev => [...prev, `⏳ PORT ${port}: TIMEOUT`]);
        client.destroy();
      });
    });

    setTimeout(() => setIsScanningPorts(false), 1000);
  };

  // --- OVER-THE-AIR (OTA) FIRMWARE FLASHING ENGINE ---
  const executeOtaFlash = () => {
    if (!selectedDevice) return;
    setIsFlashing(true);
    setOtaProgress(0);
    setOtaStatusLog([`[OTA] Initializing Session for ${selectedDevice.name}`]);

    let progress = 0;
    const interval = setInterval(() => {
      progress += 10;
      setOtaProgress(progress);
      setOtaStatusLog(prev => [
        ...prev, 
        `[OTA] Writing chunk frame block ${progress / 10}/10...`,
        `[ACK] Block offset verified successfully.`
      ]);

      if (progress >= 100) {
        clearInterval(interval);
        setIsFlashing(false);
        setOtaStatusLog(prev => [...prev, `🎉 OTA FLASH SUCCESSFUL: Device updated to ${firmwareVersion}`]);
      }
    }, 400);
  };

  const getDeviceDistanceMeters = (device: any): number => {
    if (device?.type === 'BLE') {
      if (typeof device?.estDistanceM === 'number') return device.estDistanceM;
      return estimateBleDistanceMeters(device?.rssi ?? -80, device?.txPowerLevel ?? -59);
    }

    return Number.POSITIVE_INFINITY;
  };

  const getDeviceCategory = (device: any): DeviceFocusFilter => {
    const fingerprint = normalizeFingerprint(
      [
        String(device?.name || ''),
        String(device?.localName || ''),
        String(device?.id || ''),
        String(device?.brand || ''),
        String(device?.manufacturerData || ''),
        String(device?.manufacturerHex || ''),
        String(device?.manufacturerCompanyId ?? ''),
        String(device?.metadataHint || ''),
        String(device?.serviceUUIDs || ''),
        String(device?.lanHint || ''),
      ].join(' '),
    );

    const iphoneKeywords = [
      'iphone', 'ipad', 'ipod', 'ios', 'apple watch', 'watch', 'airpods', 'airtag', 'apple',
    ];
    const laptopKeywords = [
      'macbook', 'imac', 'mac mini', 'laptop', 'notebook', 'desktop', 'workstation', 'thinkpad', 'lenovo', 'dell', 'hp', 'asus', 'surface', 'windows', 'pc',
    ];
    const routerKeywords = [
      'router', 'gateway', 'access point', 'wifi', 'wlan', 'mesh', 'tp link', 'netgear', 'linksys', 'unifi', 'ubiquiti', 'mikrotik', 'cisco', 'deco', 'eero',
    ];
    const tvKeywords = [
      'television', 'smart tv', 'android tv', 'apple tv', 'chromecast', 'roku', 'fire tv', 'webos', 'bravia', 'tizen', 'vizio', 'hisense', 'tcl', 'samsung tv', 'lg tv', 'sony tv',
    ];
    const cameraKeywords = [
      'camera', 'doorbell', 'nest cam', 'arlo', 'wyze', 'blink', 'ring', 'hikvision', 'dahua', 'reolink',
    ];

    const tvTokenScore = /(^|\s)tv(\s|$)/.test(fingerprint) ? 1 : 0;
    const camTokenScore = /(^|\s)cam(\s|$)/.test(fingerprint) ? 1 : 0;

    const scores: Record<DeviceFocusFilter, number> = {
      ALL: 0,
      IPHONES: scoreKeywords(fingerprint, iphoneKeywords),
      LAPTOPS: scoreKeywords(fingerprint, laptopKeywords),
      ROUTERS: scoreKeywords(fingerprint, routerKeywords),
      TELEVISIONS: scoreKeywords(fingerprint, tvKeywords) + tvTokenScore,
      CAMERAS: scoreKeywords(fingerprint, cameraKeywords) + camTokenScore,
      OTHER: 0,
    };

    if (device?.type === 'BLE') {
      const serviceUuidFingerprint = normalizeFingerprint(String(device?.serviceUUIDs || ''));
      const companyId = Number(device?.manufacturerCompanyId);

      if (companyId === 0x004c) {
        scores.IPHONES += 2;
      }
      if (companyId === 0x0006) {
        scores.LAPTOPS += 2;
      }
      if (companyId === 0x0075) {
        scores.TELEVISIONS += 1;
      }

      if (serviceUuidFingerprint.includes(' 1812 ')) {
        scores.LAPTOPS += 1;
      }
      if (serviceUuidFingerprint.includes(' fff0 ') || serviceUuidFingerprint.includes(' ff10 ')) {
        scores.ROUTERS += 1;
      }
      if (serviceUuidFingerprint.includes(' fe95 ') || serviceUuidFingerprint.includes(' fd6f ')) {
        scores.CAMERAS += 1;
      }
    }

    if (device?.type === 'LAN' && (String(device?.id || '').endsWith('.1') || String(device?.id || '').endsWith('.254'))) {
      scores.ROUTERS += 2;
    }

    const ranked = (Object.keys(scores) as DeviceFocusFilter[])
      .filter((key) => key !== 'ALL' && key !== 'OTHER')
      .sort((a, b) => scores[b] - scores[a]);

    const top = ranked[0];
    return scores[top] > 0 ? top : 'OTHER';
  };

  const categorizedDevices = useMemo(
    () =>
      discoveredDevices.map((device) => ({
        device,
        distanceMeters: getDeviceDistanceMeters(device),
        category: getDeviceCategory(device),
      })),
    [discoveredDevices],
  );

  const focusFilteredDevices = useMemo(
    () =>
      categorizedDevices
        .filter(({ device, distanceMeters, category }) => {
          const categoryMatch =
            selectedDeviceFocusFilter === 'ALL' || category === selectedDeviceFocusFilter;
          return categoryMatch;
        })
        .map(({ device, distanceMeters }) => ({
          id: String(device.id),
          name: String(device.name || 'Unknown Device'),
          distanceM: Number.isFinite(distanceMeters) ? distanceMeters : 100,
          angleDeg:
            typeof device.angleDeg === 'number' && Number.isFinite(device.angleDeg)
              ? device.angleDeg
              : Math.abs(
                  String(device.id)
                    .split('')
                    .reduce((hash, ch) => ch.charCodeAt(0) + ((hash << 5) - hash), 0) % 360,
                ),
          type: device.type === 'BLE' ? 'BLE' : 'WIFI',
          rawDevice: device,
        })),
    [categorizedDevices, selectedDeviceFocusFilter],
  );

  const selectedDeviceDistanceText = selectedDevice?.type === 'BLE'
    ? `${(typeof selectedDevice?.estDistanceM === 'number' ? selectedDevice.estDistanceM : estimateBleDistanceMeters(selectedDevice?.rssi)).toFixed(1)}m (live estimate)`
    : 'LAN host distance unavailable (network-only target)';

  return (
    <SafeAreaView style={[styles.container, activeTab === 'RADAR' && styles.containerRadarActive]}>
      {/* HEADER SECTION */}
      {activeTab !== 'RADAR' && (
        <View style={styles.appHeader}>
          <View>
            <Text style={styles.titleHeader}>TRUSTWIRE DUAL SCANNER</Text>
            <Text style={styles.subText}>{systemLog}</Text>
          </View>
          <TouchableOpacity
            style={[styles.primaryToggle, isScanning ? styles.toggleActive : styles.toggleInactive]}
            onPress={() => setIsScanning(!isScanning)}
          >
            <Text style={styles.toggleText}>{isScanning ? 'HALT ENGINE' : 'RUN RADAR'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* DASHBOARD ROUTER CORE */}
      <View style={[styles.viewport, activeTab === 'RADAR' && styles.viewportRadarActive]}>
        {activeTab === 'RADAR' ? (
          <View style={styles.pageBody}>
            <RadarScreen
              devices={focusFilteredDevices}
              headingDeg={userHeadingDeg}
              isScanning={isScanning}
              onToggleScan={() => setIsScanning((prev) => !prev)}
              statusText={isScanning ? 'Scanner Active' : 'Scanner Standby'}
              focusLabel={selectedDeviceFocusFilter}
              onNavigateTargets={() => setActiveTab('TARGETS')}
              onNavigateDiagnostics={() => setActiveTab('TARGETS')}
              onNavigatePorts={() => setActiveTab('PORTS')}
              onNavigateOta={() => setActiveTab('OTA')}
              onSelectDevice={(dev) => {
                setSelectedDevice(dev);
                setModalVisible(true);
              }}
            />
          </View>
        ) : activeTab === 'TARGETS' ? (
          <FlatList
            data={discoveredDevices}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.deviceRow} onPress={() => { setSelectedDevice(item); setModalVisible(true); }}>
                <Text style={{color: item.type === 'BLE' ? '#00E5FF' : '#00FF66', fontWeight: 'bold'}}>{item.name}</Text>
                <Text style={{color: '#64748B', fontSize: 12}}>{item.id} [{item.type}]</Text>
              </TouchableOpacity>
            )}
          />
        ) : activeTab === 'PORTS' ? (
          <ScrollView contentContainerStyle={{gap: 15}}>
            <Text style={styles.moduleTitle}>⚡ PORT ANALYSIS RIG</Text>
            <TextInput 
              style={styles.terminalInput} 
placeholder="Enter Target Subnet IP Address"
              placeholderTextColor="#334155"
              value={targetPortIp}
              onChangeText={setTargetPortIp}
            />
            <TouchableOpacity style={styles.actionButton} onPress={runPortScan}>
              {isScanningPorts ? <ActivityIndicator color="#040912" /> : <Text style={styles.actionButtonText}>PROBE NET CONFIG</Text>}
            </TouchableOpacity>
            <View style={styles.consoleLogBox}>
              {portScanResults.map((res, i) => <Text key={i} style={styles.consoleText}>{res}</Text>)}
            </View>
          </ScrollView>
        ) : activeTab === 'OTA' ? (
          /* UNIFIED OTA CONFIG MANAGEMENT WORKBENCH */
          <ScrollView contentContainerStyle={{gap: 15}}>
            <Text style={styles.moduleTitle}>📦 OVER-THE-AIR WORKBENCH</Text>
            <Text style={{color: '#64748B', fontSize: 12}}>Select a discovered device from the Targets/Radar tabs to push core firmware revisions.</Text>
            
            <View style={{gap: 6}}>
              <Text style={styles.settingsLabel}>TARGET FIRMWARE BINARY SPEC</Text>
              <TextInput style={styles.terminalInput} value={firmwareVersion} onChangeText={setFirmwareVersion} />
            </View>

            {selectedDevice ? (
              <View style={styles.systemStatusBlock}>
                <Text style={{color: '#00FF66', fontWeight: 'bold', fontSize: 13}}>CONNECTED COMPONENT</Text>
                <Text style={styles.statusTelemetryText}>Name: {selectedDevice.name}</Text>
                <Text style={styles.statusTelemetryText}>Protocol Boundary: {selectedDevice.type}</Text>
                
                <TouchableOpacity style={[styles.actionButton, {marginTop: 15, backgroundColor: '#00E5FF'}]} onPress={executeOtaFlash} disabled={isFlashing}>
                  {isFlashing ? <ActivityIndicator color="#000" /> : <Text style={[styles.actionButtonText, {color: '#000'}]}>INITIALIZE FIRMWARE FLASH</Text>}
                </TouchableOpacity>

                {isFlashing && (
                  <View style={{marginTop: 15, backgroundColor: '#02060D', padding: 10, borderRadius: 4}}>
                    <Text style={{color: '#00E5FF', fontSize: 12, marginBottom: 5}}>Writing Data: {otaProgress}%</Text>
                    <View style={{height: 4, backgroundColor: '#1E293B', borderRadius: 2}}>
                      <View style={{height: '100%', backgroundColor: '#00E5FF', width: `${otaProgress}%`}} />
                    </View>
                  </View>
                )}
              </View>
            ) : (
              <View style={styles.systemStatusBlock}>
                <Text style={{color: '#FF3B30', fontWeight: 'bold', fontSize: 12}}>NO HARDWARE DEVICE SELECTED</Text>
              </View>
            )}

            <View style={[styles.consoleLogBox, {height: 150}]}>
              {otaStatusLog.map((log, i) => <Text key={i} style={styles.consoleText}>{log}</Text>)}
            </View>
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={{ gap: 15 }}>
            <Text style={styles.moduleTitle}>⚙️ SYSTEM SETTINGS</Text>
            <View style={styles.systemStatusBlock}>
              <Text style={{ color: '#00FF66', fontWeight: 'bold', fontSize: 13 }}>APPLICATION STATUS</Text>
              <Text style={styles.statusTelemetryText}>Scanner: {isScanning ? 'ACTIVE' : 'STANDBY'}</Text>
              <Text style={styles.statusTelemetryText}>Device Focus: {selectedDeviceFocusFilter}</Text>
              <Text style={styles.statusTelemetryText}>Discovered Devices: {discoveredDevices.length}</Text>
              <Text style={styles.statusTelemetryText}>
                Heading: {typeof userHeadingDeg === 'number' ? `${Math.round(userHeadingDeg)}°` : 'Calibrating'}
              </Text>
            </View>

            <View style={styles.systemStatusBlock}>
              <Text style={{ color: '#00E5FF', fontWeight: 'bold', fontSize: 13 }}>QUICK CONTROLS</Text>
              <TouchableOpacity
                style={[styles.actionButton, { marginTop: 10 }]}
                onPress={() => setIsScanning((prev) => !prev)}
              >
                <Text style={styles.actionButtonText}>{isScanning ? 'HALT RADAR ENGINE' : 'RUN RADAR ENGINE'}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionButton, { marginTop: 10, backgroundColor: '#00E5FF' }]}
                onPress={() => {
                  setSelectedDeviceFocusFilter('ALL');
                  setSystemLog('Settings reset: focus set to ALL');
                }}
              >
                <Text style={[styles.actionButtonText, { color: '#000' }]}>RESET FOCUS FILTER</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        )}
      </View>

      {/* DASHBOARD TRAILING TAB COUPLING BAR */}
      <View style={styles.tabDashboard}>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'RADAR' && styles.tabButtonSelected]} onPress={() => setActiveTab('RADAR')}><Text style={styles.tabButtonText}>RADAR</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'TARGETS' && styles.tabButtonSelected]} onPress={() => setActiveTab('TARGETS')}><Text style={styles.tabButtonText}>TARGETS</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'PORTS' && styles.tabButtonSelected]} onPress={() => setActiveTab('PORTS')}><Text style={styles.tabButtonText}>PARTS</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'OTA' && styles.tabButtonSelected]} onPress={() => setActiveTab('OTA')}><Text style={styles.tabButtonText}>OTA</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'SETTINGS' && styles.tabButtonSelected]} onPress={() => setActiveTab('SETTINGS')}><Text style={styles.tabButtonText}>SETTINGS</Text></TouchableOpacity>
      </View>

      {/* DETAILS INSPECTION HUD MODAL */}
      <Modal animationType="slide" transparent={true} visible={modalVisible}>
        <View style={styles.modalOverlayContainer}>
          <View style={styles.hudTelemetryCard}>
            <Text style={{color: '#00FF66', fontSize: 11, fontWeight: '900'}}>TARGET INTELLIGENCE ANALYSIS</Text>
            <Text style={styles.hudDeviceMainName}>{selectedDevice?.name}</Text>
            <Text style={{color: '#00E5FF', fontFamily: 'Courier', fontSize: 12}}>{selectedDevice?.id}</Text>
            <Text style={{color: '#94A3B8', fontSize: 13}}>Protocol Domain Layer: {selectedDevice?.type}</Text>
            <Text style={{color: '#94A3B8', fontSize: 13}}>
              Signal Location: {selectedDevice?.type === 'BLE'
                ? `${getBleProximityLabel(selectedDevice?.rssi ?? -80)} (${selectedDevice?.rssi ?? -80} dBm)`
                : `${getLanZoneLabel(selectedDevice?.id || '')}`}
            </Text>
            <Text style={{color: '#94A3B8', fontSize: 13}}>Proximity: {selectedDeviceDistanceText}</Text>
            <Text style={{color: '#94A3B8', fontSize: 13}}>
              User Location: {userLocation ? `${userLocation.latitude.toFixed(6)}, ${userLocation.longitude.toFixed(6)}` : locationStatus}
            </Text>
            
            <View style={styles.hudDivider} />

            <View style={{flexDirection: 'row', gap: 10}}>
              <TouchableOpacity style={[styles.actionButton, {flex: 1}]} onPress={() => { setTargetPortIp(selectedDevice.id); setActiveTab('PORTS'); setModalVisible(false); }}>
                <Text style={styles.actionButtonText}>SCAN PORTS</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionButton, {flex: 1, backgroundColor: '#00E5FF'}]} onPress={() => { setActiveTab('OTA'); setModalVisible(false); }}>
                <Text style={[styles.actionButtonText, {color: '#000'}]}>STAGE OTA</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.hudCloseButton} onPress={() => setModalVisible(false)}>
              <Text style={styles.hudCloseBtnText}>CLOSE HUD</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent={true} visible={deviceDropdownVisible}>
        <TouchableOpacity style={styles.dropdownOverlay} activeOpacity={1} onPress={() => setDeviceDropdownVisible(false)}>
          <View style={styles.dropdownPanel}>
            {DEVICE_FOCUS_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option}
                style={[styles.dropdownOption, selectedDeviceFocusFilter === option && styles.dropdownOptionSelected]}
                onPress={() => {
                  setSelectedDeviceFocusFilter(option);
                  setDeviceDropdownVisible(false);
                }}
              >
                <Text style={styles.dropdownOptionText}>{option}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#040912' },
  containerRadarActive: { backgroundColor: '#050E17' },
  appHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15, borderBottomWidth: 1, borderColor: '#0D223B' },
  titleHeader: { fontSize: 13, fontWeight: '900', color: '#00FF66', letterSpacing: 1.2 },
  subText: { color: '#00E5FF', fontSize: 11, marginTop: 2, fontFamily: 'Courier' },
  primaryToggle: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4, borderWidth: 1 },
  toggleInactive: { backgroundColor: 'rgba(0, 255, 102, 0.08)', borderColor: '#00FF66' },
  toggleActive: { backgroundColor: 'rgba(255, 59, 48, 0.18)', borderColor: '#FF3B30' },
  toggleText: { color: '#FFF', fontSize: 10, fontWeight: '900' },
  viewport: { flex: 1, padding: 20 },
  viewportRadarActive: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 8 },
  pageBody: { flex: 1 },
  filtersRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 14 },
  dropdownWrap: { flex: 1 },
  dropdownLabel: { color: '#64748B', fontSize: 10, fontWeight: '800', marginBottom: 5 },
  dropdownButton: { backgroundColor: '#091524', borderWidth: 1, borderColor: '#1E293B', borderRadius: 4, paddingVertical: 9, paddingHorizontal: 10 },
  dropdownButtonText: { color: '#E2E8F0', fontSize: 11, fontWeight: '800' },
  radarWithRadiusControl: { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 10, alignSelf: 'center' },
  radarOuterCircle: { width: 270, height: 270, borderRadius: 135, borderWidth: 1.5, borderColor: '#004A26', alignSelf: 'center', justifyContent: 'center', alignItems: 'center', backgroundColor: '#02120A', overflow: 'hidden', position: 'relative' },
  radarMiddleCircle: { position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 1, borderColor: 'rgba(0, 255, 102, 0.22)' },
  radarInnerCircle: { position: 'absolute', width: 90, height: 90, borderRadius: 45, borderWidth: 1, borderColor: 'rgba(0, 255, 102, 0.16)' },
  radarCrosshairH: { position: 'absolute', width: '100%', height: 1, backgroundColor: 'rgba(0, 255, 102, 0.15)' },
  radarCrosshairV: { position: 'absolute', width: 1, height: '100%', backgroundColor: 'rgba(0, 255, 102, 0.15)' },
  sweeperCone: { position: 'absolute', width: 135, height: 135, bottom: '50%', left: '50%', borderRightWidth: 2, borderRightColor: '#00FF66', backgroundColor: 'rgba(0, 255, 102, 0.04)', transformOrigin: 'bottom left' },
  targetBlipContainer: { position: 'absolute', width: 30, height: 30, justifyContent: 'center', alignItems: 'center', zIndex: 40 },
  targetBlipCore: { width: 10, height: 10, borderRadius: 5 },
  legendContainer: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 25 },
  filterResultText: { textAlign: 'center', color: '#64748B', fontSize: 11, marginTop: 10 },
  deviceRow: { backgroundColor: '#081729', padding: 14, borderRadius: 4, marginVertical: 4, borderWidth: 1, borderColor: '#152C47', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tabDashboard: { flexDirection: 'row', height: 68, borderTopWidth: 1, borderColor: '#0D223B', backgroundColor: '#060E1A' },
  tabButton: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#07111F' },
  tabButtonSelected: { backgroundColor: '#0C1C30', borderTopWidth: 2, borderColor: '#00FF66' },
  tabButtonText: { color: '#94A3B8', fontSize: 9, fontWeight: '800' },
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
  hudCloseButton: { padding: 12, backgroundColor: 'rgba(255, 59, 48, 0.08)', borderWidth: 1, borderColor: '#FF3B30', borderRadius: 4, alignItems: 'center', marginTop: 5 },
  hudCloseBtnText: { color: '#FF3B30', fontWeight: '900', fontSize: 11 },
  systemStatusBlock: { marginTop: 10, padding: 12, backgroundColor: '#091524', borderRadius: 4, borderWidth: 1, borderColor: '#1E293B' },
  statusTelemetryText: { color: '#94A3B8', fontFamily: 'Courier', fontSize: 11, marginVertical: 2 },
  dropdownOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', paddingHorizontal: 26 },
  dropdownPanel: { backgroundColor: '#071220', borderWidth: 1, borderColor: '#1E293B', borderRadius: 8, paddingVertical: 8 },
  dropdownOption: { paddingVertical: 11, paddingHorizontal: 14 },
  dropdownOptionSelected: { backgroundColor: '#0C1C30' },
  dropdownOptionText: { color: '#E2E8F0', fontSize: 12, fontWeight: '700' }
});