# Trustwire

Trustwire now includes an Expo Router home radar screen (`app/index.tsx`) that continuously scans for:

- Bluetooth Low Energy (BLE) devices
- Devices/services discoverable on the same local network (mDNS/zeroconf)

## Required packages

Install these in your React Native app:

- `react-native-ble-plx`
- `react-native-zeroconf`

## Permission setup

### Android (`android/app/src/main/AndroidManifest.xml`)

Add:

- `BLUETOOTH_SCAN`
- `BLUETOOTH_CONNECT`
- `ACCESS_FINE_LOCATION`
- `INTERNET`
- `ACCESS_WIFI_STATE`
- `CHANGE_WIFI_MULTICAST_STATE` (recommended for mDNS discovery)

### iOS (`ios/<YourApp>/Info.plist`)

Add usage descriptions:

- `NSBluetoothAlwaysUsageDescription`
- `NSLocalNetworkUsageDescription`

Use the exact entries below inside your `Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app requires Bluetooth access to scan for nearby devices on the radar.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>This app requires local network access to discover devices on the same Wi-Fi.</string>
```

If you need Bonjour service discovery, also add `NSBonjourServices` entries for your service types (for example `_http._tcp`).

## Behavior

- Radar animation runs continuously.
- BLE scan starts immediately and refreshes periodically.
- LAN scan uses zeroconf and refreshes periodically.
- Discovered devices are listed in descending `lastSeen` order.

## Running modes (important)

Trustwire is configured to launch the app UI directly (no Expo launcher/login screen).

- For development with live reload: run the Metro server and open Trustwire.
- For distribution/user usage: install a **Release** build.

### iOS

- Dev flow: `npm run dev` (or `npm run start:dev-client`) + `npm run ios:dev`
- User-like flow: `npm run ios:release`

### Android

- Dev flow: `npm run dev` + `npm run android:dev`
- User-like flow: `npm run android:release`

### Quick script check

Run `npm run` to list all available scripts.
