# LUDO 804 — Google Play Compliance, Privacy Policy & Data Safety Summary

## 1. Monetization & Virtual Currency Model
- **Model**: 100% Free-to-Play Ludo game supported exclusively by Google AdMob advertisements (Adaptive Banner, Match-End Interstitial, Optional Rewarded Video).
- **Virtual Stars**: Players can optionally watch a Google AdMob Rewarded Video Ad to receive `+20` entertainment-only Virtual Stars.
- **No Real-Money Gambling / No In-App Purchases**:
  - Zero in-app purchase buttons, payment SDKs, or external wallets exist in the app.
  - Virtual Stars cannot be purchased, traded, wagered for cash, or withdrawn.
  - All game modes (Online Private Room, Quick Match `8040`, Offline Pass & Play) are free (`0` entry fee).

## 2. Google Play Data Safety Form Declarations
When completing **App content → Data safety** in Google Play Console:
- **Does your app collect or share any required user data types?** Yes (via Firebase Anonymous Auth/RTDB for multiplayer + Google AdMob SDK for ads):
  - **Device or other IDs**: Advertising ID (`AD_ID` via Google AdMob SDK) & Anonymous User ID (`playerId` / Firebase anonymous UID) — used for Advertising, Fraud Prevention/Security (SSV nonces), and App Functionality (multiplayer room membership & virtual star ledger).
  - **Personal Info (Optional User-Provided)**: Display Name, City/Region, and optional Avatar image stored locally and shared within active multiplayer rooms during matches.
  - **In-App Messages**: Live Room Chat messages visible only to members of the active room code.
- **Is data encrypted in transit?** Yes — `cleartext` and `allowMixedContent` are disabled (`capacitor.config.ts` & `AndroidManifest.xml`), enforcing HTTPS / WSS in release builds.
- **Do you provide a way for users to request data deletion?** Yes — In-app Privacy Policy lists `muafiskv8537@gmail.com` for data deletion inquiries alongside device storage clearing.

## 3. AdMob & Consent Policies
- **User Messaging Platform (UMP)**: `AdMob.requestConsentInfo()` and `AdMob.showConsentForm()` are integrated in `src/services/admob.ts` during initialization.
- **Accidental Click & Reward Integrity**:
  - Bottom banner renders cleanly outside active board tap zones.
  - Rewarded ads are strictly opt-in (`WATCH REWARDED AD (+20 STARS)`), never forced mid-turn, and never encourage ad clicks.
  - Credits unlock only after AdMob SDK `RewardAdPluginEvents.Rewarded` completes and backend verifies the single-use nonce (plus Google ECDSA SSV webhook when `ADMOB_REQUIRE_SSV=true`).

## 4. Target Audience & Content Rating (IARC)
- Recommended Target Age Group in Play Console: **13+ / Everyone (Social Board Game with Live User Chat & AdMob Ads)**.
- Make sure your Google Play Store listing and AdMob app settings match the same age rating and ad content filter.
