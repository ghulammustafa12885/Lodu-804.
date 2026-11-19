# LUDO 804 — Android APK, AAB & Google Play Release Guide

## Tech Stack
- **Frontend**: Vite + React 19 + TypeScript + Tailwind CSS v4 + `vite-plugin-pwa`
- **Backend / Authoritative Multiplayer & Ledger**: Express + WebSocket (`ws`) + Node `crypto` RNG
- **Firebase**: `firebase/app`, `firebase/auth` (Anonymous), `firebase/database` (Realtime Database + Presence)
- **Android Wrapper**: Capacitor 8 (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/app`)
- **Ads SDK**: `@capacitor-community/admob` (Banner, Interstitial, Rewarded Ads + UMP Consent + SSV)
- **Package ID**: `com.kaptaan804.ludo`
- **Business Model**: 100% Free-to-Play entertainment with optional Google AdMob Rewarded Ads (+20 Virtual Stars per verified completed view). Zero purchases, zero gambling, zero cash value.

---

## Prerequisites (Local Computer or CI Build Machine)
1. **Node.js 20+** and **npm**
2. **Java Development Kit (JDK 17 or JDK 21)**
3. **Android Studio** (Android SDK Platform 36, Build-Tools, Gradle)

---

## Required Production Configuration

### 1. Hosted Express + WebSocket Multiplayer & Reward Server
Deploy `server.ts` on an HTTPS host (Cloud Run, Fly.io, Render, VPS, etc.) and set:
- `VITE_API_URL=https://your-live-server.example.com`
- `REWARD_HMAC_SECRET=<strong-random-64-char-hex-string>`
- `ADMOB_REQUIRE_SSV=true` (**enabled by default**; AdMob SSV callback URL must point to `https://your-live-server.example.com/api/admob/ssv`)
- `FIREBASE_SERVICE_ACCOUNT_JSON=<service-account-json>` (**required** for server-side Firebase RTDB persistence of stars, nonces, SSV receipts & `rewardTransactions`)
- `FIREBASE_WEB_API_KEY=<firebase-web-api-key>` (optional server-side alias for verifying Anonymous Auth tokens)

### 2. Firebase Authentication, Realtime Database & `google-services.json`
1. Set your real Firebase Web App credentials in `.env` (for the web & Capacitor WebView SDK in `src/services/firebase.ts`):
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN` (default: `ludo-804.firebaseapp.com`)
   - `VITE_FIREBASE_DATABASE_URL` (default: `https://ludo-804-default-rtdb.firebaseio.com`)
   - `VITE_FIREBASE_PROJECT_ID` (default: `ludo-804`)
   - `VITE_FIREBASE_STORAGE_BUCKET` (default: `ludo-804.appspot.com`)
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
2. In **Firebase Console → Authentication → Sign-in method**, enable **Anonymous**.
3. Deploy `/database.rules.json` to your Firebase Realtime Database (`firebase deploy --only database`). Client writes to `users/$uid/stars` and `rewardTransactions/$uid` are explicitly denied (`".write": false`) to prevent balance tampering.
4. **Native Android `google-services.json` placement**:
   - Place your Firebase Android config file at **`android/app/google-services.json`** (package name: `com.kaptaan804.ludo`).
   - `android/app/build.gradle` automatically detects `android/app/google-services.json` and applies `com.google.gms.google-services` only when the file is non-empty.
   - Note: `debug` builds use `applicationIdSuffix ".debug"` (`com.kaptaan804.ludo.debug`). If you add `android/app/google-services.json`, either include both `com.kaptaan804.ludo` and `com.kaptaan804.ludo.debug` in `google-services.json` or test release builds (`assembleRelease` / `bundleRelease`).

### 3. Google AdMob (Android Production IDs)
1. Replace the sample test App ID (`ca-app-pub-3940256099942544~3347511713`) in **`android/app/src/main/res/values/strings.xml`** (`admob_app_id`) AND set **`VITE_ADMOB_APP_ID`** in `.env` with your live **AdMob App ID** (`ca-app-pub-XXXXXXXXXXXXXXXX~YYYYYYYYYY`).
2. Add your 3 real Ad Unit IDs (`ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY`) to `.env`:
   - `VITE_ADMOB_BANNER_ID`
   - `VITE_ADMOB_INTERSTITIAL_ID`
   - `VITE_ADMOB_REWARDED_ID`
3. In **AdMob Console → Rewarded Ad Unit → Server-side verification**, set the callback URL to:
   `https://your-live-server.example.com/api/admob/ssv`

### 4. Android Release Keystore & Gradle Signing Properties (`bundleRelease`)
Generate a release keystore (one time — store backups safely, never commit to Git):
```bash
keytool -genkeypair -v -keystore ludo804-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ludo804
```
Configure the 4 Gradle signing variables required by `android/app/build.gradle` (either as OS environment variables OR in `~/.gradle/gradle.properties`):
- `LUDO_RELEASE_STORE_FILE` (absolute path to `ludo804-release.jks`, or path relative to `android/app/`)
- `LUDO_RELEASE_STORE_PASSWORD`
- `LUDO_RELEASE_KEY_ALIAS` (e.g. `ludo804`)
- `LUDO_RELEASE_KEY_PASSWORD`

Additional Gradle/SDK checks before building:
- Ensure `ANDROID_HOME` (or `sdk.dir=/path/to/Android/Sdk` in `android/local.properties`) points to Android SDK with **Platform 36** installed.
- Ensure **JDK 21** is active (`JAVA_HOME`).
- Increment `versionCode` and `versionName` in `android/app/build.gradle` before each Play Console upload.

---

## Building Debug APK & Signed Release AAB
```bash
# 1. Install dependencies & compile production web bundle + sync Capacitor Android
npm install
npm run build:android

# 2. Option A: Build from command line (with JDK 21 + Android SDK 36 installed)
cd android
./gradlew assembleDebug

# Signed Release App Bundle (.aab) for Google Play Store
export LUDO_RELEASE_STORE_FILE=/path/to/ludo804-release.jks
export LUDO_RELEASE_STORE_PASSWORD=your-store-password
export LUDO_RELEASE_KEY_ALIAS=ludo804
export LUDO_RELEASE_KEY_PASSWORD=your-key-password
./gradlew bundleRelease

# 3. Option B: Open directly in Android Studio
npx cap open android
```
Output locations:
- Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`
- Signed Release APK: `android/app/build/outputs/apk/release/app-release.apk`
- Signed Play Store AAB: `android/app/build/outputs/bundle/release/app-release.aab`
