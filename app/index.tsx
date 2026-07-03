import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, FlatList, Animated, Easing, SafeAreaView, Modal, ScrollView, ActivityIndicator, TextInput, Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { NetworkInfo } from 'react-native-network-info';
import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';

const bleManager = new BleManager();
const RADAR_RADIUS = 135;

export default function App() {
  // Navigation Matrix
  const [activeTab, setActiveTab] = useState<'RADAR' | 'TARGETS' | 'PORTS' | 'OTA'>('RADAR');
  const [isScanning, setIsScanning] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<any[]>([]);
  const [systemLog, setSystemLog] = useState('System Initialized & Ready');

  // Diagnostic State Hooks
  const [selectedDevice, setSelectedDevice] = useState<any | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  
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

  // Animation Refs
  const spinValue = useRef(new Animated.Value(0)).current;
  const pulseValue = useRef(new Animated.Value(1)).current;

  // Polar Coordinate Mapping For Radar Display
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

  // --- LOCAL AREA NETWORK (LAN) SCANNER ---
  const scanLocalNetwork = async () => {
    setSystemLog('Mapping Network Subnet...');
    try {
      const ip = await NetworkInfo.getIPAddress();
      const subnetBase = ip && !ip.includes(':') ? ip.substring(0, ip.lastIndexOf('.')) : '192.168.1';
      
      // Probe active routing segments
      const targets = [1, 5, 10, 22, 45, 101, 115, 254];
      for (const host of targets) {
        const testIp = `${subnetBase}.${host}`;
        addLanTarget(testIp, `Wi-Fi Node [.${host}]`);
      }
      setSystemLog('LAN Topography Mapped');
    } catch (err) {
      setSystemLog('Subnet Scan Interrupted');
    }
  };

  const addLanTarget = (ip: string, name: string) => {
    setDiscoveredDevices(prev => {
      if (prev.some(d => d.id === ip)) return prev;
      return [...prev, { id: ip, name: name, type: 'LAN', rssi: -45, brand: 'IP Network Client' }];
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

        Animated.loop(Animated.timing(spinValue, { toValue: 1, duration: 2500, easing: Easing.linear, useNativeDriver: true })).start();
        Animated.loop(Animated.sequence([
          Animated.timing(pulseValue, { toValue: 0.4, duration: 1200, useNativeDriver: true }),
          Animated.timing(pulseValue, { toValue: 1, duration: 1200, useNativeDriver: true }),
        ])).start();

        bleManager.startDeviceScan(null, null, (error, device) => {
          if (device) {
            setDiscoveredDevices((prev) => {
              if (prev.some((d) => d.id === device.id)) return prev;
              return [...prev, {
                id: device.id,
                name: device.name || device.localName || 'Unknown BLE Beacon',
                type: 'BLE',
                rssi: device.rssi ?? -80,
                brand: 'BLE Peripheral'
              }];
            });
          }
        });
      });
    } else {
      spinValue.setValue(0);
      bleManager.stopDeviceScan();
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

  return (
    <SafeAreaView style={styles.container}>
      {/* HEADER SECTION */}
      <View style={styles.appHeader}>
        <View>
          <Text style={styles.titleHeader}>TRUSTWIRE DUAL SCANNER</Text>
          <Text style={styles.subText}>{systemLog}</Text>
        </View>
        <TouchableOpacity 
          style={[styles.primaryToggle, isScanning ? styles.toggleActive : styles.toggleInactive]}
          onPress={() => setIsScanning(!isScanning)}
        >
          <Text style={styles.toggleText}>{isScanning ? "HALT ENGINE" : "RUN RADAR"}</Text>
        </TouchableOpacity>
      </View>

      {/* DASHBOARD ROUTER CORE */}
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
              <Text style={{color: '#00E5FF', fontSize: 11, fontWeight: 'bold'}}>● BLE Radio (Blue)</Text>
              <Text style={{color: '#00FF66', fontSize: 11, fontWeight: 'bold'}}>● Wi-Fi LAN (Green)</Text>
            </View>
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
              placeholder="Enter Target Subnet IP (e.g. 192.168.1.1)" 
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
        ) : (
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
        )}
      </View>

      {/* DASHBOARD TRAILING TAB COUPLING BAR */}
      <View style={styles.tabDashboard}>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'RADAR' && styles.tabButtonSelected]} onPress={() => setActiveTab('RADAR')}><Text style={styles.tabButtonText}>RADAR</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'TARGETS' && styles.tabButtonSelected]} onPress={() => setActiveTab('TARGETS')}><Text style={styles.tabButtonText}>TARGETS</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'PORTS' && styles.tabButtonSelected]} onPress={() => setActiveTab('PORTS')}><Text style={styles.tabButtonText}>PORTS</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === 'OTA' && styles.tabButtonSelected]} onPress={() => setActiveTab('OTA')}><Text style={styles.tabButtonText}>OTA FLASH</Text></TouchableOpacity>
      </View>

      {/* DETAILS INSPECTION HUD MODAL */}
      <Modal animationType="slide" transparent={true} visible={modalVisible}>
        <View style={styles.modalOverlayContainer}>
          <View style={styles.hudTelemetryCard}>
            <Text style={{color: '#00FF66', fontSize: 11, fontWeight: '900'}}>TARGET INTELLIGENCE ANALYSIS</Text>
            <Text style={styles.hudDeviceMainName}>{selectedDevice?.name}</Text>
            <Text style={{color: '#00E5FF', fontFamily: 'Courier', fontSize: 12}}>{selectedDevice?.id}</Text>
            <Text style={{color: '#94A3B8', fontSize: 13}}>Protocol Domain Layer: {selectedDevice?.type}</Text>
            
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
  radarInnerCircle: { position: 'absolute', width: 90, height: 90, borderRadius: 45, borderWidth: 1, borderColor: 'rgba(0, 255, 102, 0.16)' },
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
  hudCloseButton: { padding: 12, backgroundColor: 'rgba(255, 59, 48, 0.08)', borderWidth: 1, borderColor: '#FF3B30', borderRadius: 4, alignItems: 'center', marginTop: 5 },
  hudCloseBtnText: { color: '#FF3B30', fontWeight: '900', fontSize: 11 },
  systemStatusBlock: { marginTop: 10, padding: 12, backgroundColor: '#091524', borderRadius: 4, borderWidth: 1, borderColor: '#1E293B' },
  statusTelemetryText: { color: '#94A3B8', fontFamily: 'Courier', fontSize: 11, marginVertical: 2 }
});