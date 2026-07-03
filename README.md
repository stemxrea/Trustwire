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

### 1. Log in to your Expo account and create the EAS project

```bash
eas login
eas project:init   # generates your EAS project ID
```

Replace `YOUR_EAS_PROJECT_ID` in **both** `app.json` fields with the UUID printed by the command above:

```json
// app.json
"updates": { "url": "https://u.expo.dev/<your-project-id>" },
"extra":   { "eas": { "projectId": "<your-project-id>" } }
```

### 2. Set required environment variables

Submit credentials are read from environment variables so that no secrets are committed to the repository:

| Variable | Where to get it |
|----------|----------------|
| `EXPO_APPLE_ID` | Your Apple ID email address |
| `EXPO_ASC_APP_ID` | App Store Connect → App Information → Apple ID |
| `EXPO_APPLE_TEAM_ID` | Apple Developer Portal → Membership |
| `EXPO_GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | Path to the JSON key downloaded from [Google Cloud Console](https://console.cloud.google.com) → IAM → Service Accounts |

Set them in your shell or CI environment before running `eas submit`:

```bash
export EXPO_APPLE_ID="you@example.com"
export EXPO_ASC_APP_ID="1234567890"
export EXPO_APPLE_TEAM_ID="ABCDE12345"
export EXPO_GOOGLE_SERVICE_ACCOUNT_KEY_PATH="/path/to/google-service-account.json"
```

> **Note:** The Google service-account JSON file is listed in `.gitignore` and must never be committed to the repository.

### 3. Configure EAS for your project (first time only)

```bash
eas build:configure
```

### 4. Build a production binary

```bash
# iOS (.ipa)
eas build --platform ios --profile production

# Android (.apk / .aab)
eas build --platform android --profile production

# Both platforms at once
eas build --platform all --profile production
```

### 5. Submit to the stores

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
