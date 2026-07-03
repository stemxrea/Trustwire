# Trustwire

A React Native (Expo) mobile app with **Over-The-Air (OTA) update** support, available on both the iOS App Store and Google Play Store.

---

## Features

- 🔄 **OTA updates** — delivers JavaScript/asset updates instantly to users via [expo-updates](https://docs.expo.dev/versions/latest/sdk/updates/), without requiring a full app store submission.
- 📱 **Cross-platform** — runs on iOS and Android from a single codebase.
- 🏪 **App store ready** — configured for EAS Build & Submit to publish to the Apple App Store and Google Play Store.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18 or later |
| Expo CLI | `npx expo` (bundled) |
| EAS CLI | `npm install -g eas-cli` |

---

## Getting Started

```bash
# Install dependencies
npm install

# Start the development server
npm start

# Run on Android emulator / device
npm run android

# Run on iOS simulator (macOS only)
npm run ios
```

---

## OTA Updates

OTA updates allow you to push JavaScript and asset changes to users immediately — no app store review required.

### How it works

1. The app calls `Updates.checkForUpdateAsync()` on launch.
2. If a new bundle is available on the update channel, it is downloaded in the background.
3. The user is prompted to restart; the new version is applied on next launch.

### Publishing an OTA update

```bash
# Publish to the production channel
eas update --channel production --message "Fix: improve loading performance"

# Publish to preview (internal testers)
eas update --channel preview --message "WIP: new dashboard"
```

---

## Building for the App Stores

Trustwire uses [EAS Build](https://docs.expo.dev/build/introduction/) to produce native binaries for app store submission.

### 1. Log in to your Expo account

```bash
eas login
```

### 2. Configure EAS for your project (first time only)

```bash
eas build:configure
```

Update `eas.json` with your Apple ID, App Store Connect App ID, Apple Team ID, and the path to your Google service-account JSON before submitting.

### 3. Build a production binary

```bash
# iOS (.ipa)
eas build --platform ios --profile production

# Android (.apk / .aab)
eas build --platform android --profile production

# Both platforms at once
eas build --platform all --profile production
```

### 4. Submit to the stores

```bash
# iOS → Apple App Store
eas submit --platform ios --profile production

# Android → Google Play Store
eas submit --platform android --profile production
```

---

## Project Structure

```
Trustwire/
├── App.tsx          # Root component with OTA update UI
├── index.ts         # Entry point
├── app.json         # Expo / app store configuration
├── eas.json         # EAS Build & Submit profiles
├── package.json
├── tsconfig.json
└── assets/          # Icons, splash screen, favicon
```

---

## App Store Configuration

Edit `app.json` to set your bundle identifiers and version numbers before building:

| Field | iOS | Android |
|-------|-----|---------|
| Bundle ID / Package | `ios.bundleIdentifier` | `android.package` |
| Build number | `ios.buildNumber` | `android.versionCode` |
| Display version | `expo.version` | `expo.version` |

---

## License

MIT
