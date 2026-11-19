import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import {
  AdMob,
  AdmobConsentStatus,
  BannerAdOptions,
  BannerAdPosition,
  BannerAdSize,
  InterstitialAdPluginEvents,
  RewardAdOptions,
  RewardAdPluginEvents,
} from '@capacitor-community/admob';

// Official Google AdMob Android Test App & Ad Unit IDs (TEST ONLY — never valid for Production Release)
const TEST_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
const TEST_PUBLISHER_PREFIX = 'ca-app-pub-3940256099942544';
const TEST_BANNER_ID = 'ca-app-pub-3940256099942544/6300978111';
const TEST_INTERSTITIAL_ID = 'ca-app-pub-3940256099942544/1033173712';
const TEST_REWARDED_ID = 'ca-app-pub-3940256099942544/5224354917';

const ENV_APP_ID = import.meta.env?.VITE_ADMOB_APP_ID?.trim() || '';
const ENV_BANNER_ID = import.meta.env?.VITE_ADMOB_BANNER_ID?.trim() || '';
const ENV_INTERSTITIAL_ID = import.meta.env?.VITE_ADMOB_INTERSTITIAL_ID?.trim() || '';
const ENV_REWARDED_ID = import.meta.env?.VITE_ADMOB_REWARDED_ID?.trim() || '';

export const ADMOB_UNIT_IDS = {
  appId: ENV_APP_ID || TEST_APP_ID,
  banner: ENV_BANNER_ID || TEST_BANNER_ID,
  interstitial: ENV_INTERSTITIAL_ID || TEST_INTERSTITIAL_ID,
  rewarded: ENV_REWARDED_ID || TEST_REWARDED_ID,
};

function isRealAdMobId(id: string, kind: 'app' | 'unit'): boolean {
  const clean = id.trim();
  if (!clean) return false;
  if (clean.startsWith(TEST_PUBLISHER_PREFIX)) return false;
  return kind === 'app'
    ? /^ca-app-pub-\d{16}~\d{10}$/.test(clean)
    : /^ca-app-pub-\d{16}\/\d{10}$/.test(clean);
}

export function isUsingTestAdMobIds(): boolean {
  return (
    !isRealAdMobId(ENV_APP_ID, 'app') ||
    !isRealAdMobId(ENV_BANNER_ID, 'unit') ||
    !isRealAdMobId(ENV_INTERSTITIAL_ID, 'unit') ||
    !isRealAdMobId(ENV_REWARDED_ID, 'unit')
  );
}

export function getAdMobReleaseReadiness(): {
  productionReady: boolean;
  usingTestAppId: boolean;
  usingTestBannerId: boolean;
  usingTestInterstitialId: boolean;
  usingTestRewardedId: boolean;
  missingItems: string[];
} {
  const usingTestAppId = !isRealAdMobId(ENV_APP_ID, 'app');
  const usingTestBannerId = !isRealAdMobId(ENV_BANNER_ID, 'unit');
  const usingTestInterstitialId = !isRealAdMobId(ENV_INTERSTITIAL_ID, 'unit');
  const usingTestRewardedId = !isRealAdMobId(ENV_REWARDED_ID, 'unit');

  const missingItems: string[] = [];
  if (usingTestAppId) missingItems.push('VITE_ADMOB_APP_ID & strings.xml admob_app_id');
  if (usingTestBannerId) missingItems.push('VITE_ADMOB_BANNER_ID');
  if (usingTestInterstitialId) missingItems.push('VITE_ADMOB_INTERSTITIAL_ID');
  if (usingTestRewardedId) missingItems.push('VITE_ADMOB_REWARDED_ID');

  return {
    productionReady: missingItems.length === 0,
    usingTestAppId,
    usingTestBannerId,
    usingTestInterstitialId,
    usingTestRewardedId,
    missingItems,
  };
}

export function isNativeAdMobAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

let initialized = false;
let initPromise: Promise<boolean> | null = null;

export const INTERSTITIAL_COOLDOWN_MS = 120_000;
const LAST_INTERSTITIAL_STORAGE_KEY = '804_last_interstitial_at';
let lastInterstitialShownAt = 0;

function readLastInterstitialTimestamp(): number {
  let stored = 0;
  try {
    if (typeof localStorage !== 'undefined') {
      stored = parseInt(localStorage.getItem(LAST_INTERSTITIAL_STORAGE_KEY) || '0', 10) || 0;
    }
  } catch {
    // ignore storage limits
  }
  return Math.max(lastInterstitialShownAt, stored);
}

export function recordInterstitialOrRewardShown(now: number = Date.now()): void {
  lastInterstitialShownAt = now;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_INTERSTITIAL_STORAGE_KEY, String(now));
    }
  } catch {
    // ignore storage limits
  }
}

export function canShowInterstitialNow(now: number = Date.now()): boolean {
  const last = readLastInterstitialTimestamp();
  return last <= 0 || now - last >= INTERSTITIAL_COOLDOWN_MS;
}

export function resetAdFrequencyStateForTests(): void {
  lastInterstitialShownAt = 0;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LAST_INTERSTITIAL_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * Initializes Google AdMob SDK and checks UMP Privacy/Consent status where required.
 */
export async function initializeAdMob(): Promise<boolean> {
  if (!isNativeAdMobAvailable()) return false;
  if (initialized) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await AdMob.initialize({
        initializeForTesting: isUsingTestAdMobIds(),
      });

      try {
        const consentInfo = await AdMob.requestConsentInfo();
        if (
          consentInfo.isConsentFormAvailable &&
          consentInfo.status === AdmobConsentStatus.REQUIRED
        ) {
          await AdMob.showConsentForm();
        }
      } catch (consentErr) {
        console.warn('AdMob consent info skipped:', consentErr);
      }

      initialized = true;
      return true;
    } catch (err) {
      console.warn('AdMob initialize error:', err);
      return false;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export async function showNativeBannerAd(): Promise<boolean> {
  if (!isNativeAdMobAvailable()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;

  try {
    const ready = await initializeAdMob();
    if (!ready) return false;

    const options: BannerAdOptions = {
      adId: ADMOB_UNIT_IDS.banner,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: BannerAdPosition.BOTTOM_CENTER,
      margin: 0,
      isTesting: !isRealAdMobId(ENV_BANNER_ID, 'unit'),
    };
    await AdMob.showBanner(options);
    return true;
  } catch (err) {
    console.warn('AdMob banner unavailable:', err);
    return false;
  }
}

export async function hideNativeBannerAd(): Promise<void> {
  if (!isNativeAdMobAvailable()) return;
  try {
    await AdMob.hideBanner();
  } catch {
    // ignore if banner was not mounted
  }
}

export async function showNativeInterstitialAd(): Promise<boolean> {
  if (!isNativeAdMobAvailable()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  if (!canShowInterstitialNow()) {
    return false;
  }

  const ready = await initializeAdMob();
  if (!ready) return false;

  const handles: PluginListenerHandle[] = [];

  try {
    return await new Promise<boolean>(async (resolve) => {
      let settled = false;
      const finish = async (shown: boolean) => {
        if (settled) return;
        settled = true;
        if (shown) {
          recordInterstitialOrRewardShown();
        }
        for (const h of handles) {
          await h.remove().catch(() => {});
        }
        resolve(shown);
      };

      const dismissHandle = await AdMob.addListener(InterstitialAdPluginEvents.Dismissed, () => {
        void finish(true);
      });
      const failLoadHandle = await AdMob.addListener(InterstitialAdPluginEvents.FailedToLoad, () => {
        void finish(false);
      });
      const failShowHandle = await AdMob.addListener(InterstitialAdPluginEvents.FailedToShow, () => {
        void finish(false);
      });
      handles.push(dismissHandle, failLoadHandle, failShowHandle);

      try {
        await AdMob.prepareInterstitial({
          adId: ADMOB_UNIT_IDS.interstitial,
          isTesting: !isRealAdMobId(ENV_INTERSTITIAL_ID, 'unit'),
        });
        await AdMob.showInterstitial();
      } catch (err) {
        console.warn('AdMob interstitial failed:', err);
        await finish(false);
      }
    });
  } catch {
    return false;
  }
}

export interface RewardedAdResult {
  rewarded: boolean;
  unavailable: boolean;
  adUnitId: string;
  message: string;
}

/**
 * Displays a genuine Google AdMob Rewarded Video Advertisement with Server-Side Verification metadata.
 * Rewards are ONLY reported when AdMob emits RewardAdPluginEvents.Rewarded before Dismissed.
 * Never simulates completion via timers or dummy callbacks.
 */
export async function showNativeRewardedAd(
  rewardNonce: string,
  userId: string
): Promise<RewardedAdResult> {
  const adUnitId = ADMOB_UNIT_IDS.rewarded;

  if (!isNativeAdMobAvailable()) {
    return {
      rewarded: false,
      unavailable: true,
      adUnitId,
      message:
        'Google AdMob Rewarded Ads run inside the signed Android app on mobile devices. Continue playing Ludo 804 completely free!',
    };
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return {
      rewarded: false,
      unavailable: true,
      adUnitId,
      message:
        'Internet connection is required to load a Google AdMob rewarded ad. Offline Pass & Play remains available!',
    };
  }

  const ready = await initializeAdMob();
  if (!ready) {
    return {
      rewarded: false,
      unavailable: true,
      adUnitId,
      message: 'Google AdMob SDK is not ready right now. Please try again in a moment.',
    };
  }

  const handles: PluginListenerHandle[] = [];

  return new Promise<RewardedAdResult>(async (resolve) => {
    let rewardGrantedByAdMob = false;
    let settled = false;

    const cleanup = async () => {
      for (const h of handles) {
        await h.remove().catch(() => {});
      }
    };

    const finish = async (result: RewardedAdResult) => {
      if (settled) return;
      settled = true;
      await cleanup();
      resolve(result);
    };

    try {
      const rewardHandle = await AdMob.addListener(RewardAdPluginEvents.Rewarded, () => {
        rewardGrantedByAdMob = true;
      });

      const dismissedHandle = await AdMob.addListener(RewardAdPluginEvents.Dismissed, () => {
        if (rewardGrantedByAdMob) {
          recordInterstitialOrRewardShown();
          void finish({
            rewarded: true,
            unavailable: false,
            adUnitId,
            message: 'Ad completed! Verifying +20 Virtual Stars reward...',
          });
        } else {
          void finish({
            rewarded: false,
            unavailable: false,
            adUnitId,
            message: 'Ad closed before finishing. Watch the full ad to receive +20 Virtual Stars.',
          });
        }
      });

      const failedToLoadHandle = await AdMob.addListener(RewardAdPluginEvents.FailedToLoad, (err) => {
        console.warn('Rewarded ad failed to load:', err);
        void finish({
          rewarded: false,
          unavailable: true,
          adUnitId,
          message: 'No advertisement is currently available from AdMob. Please try again later!',
        });
      });

      const failedToShowHandle = await AdMob.addListener(RewardAdPluginEvents.FailedToShow, (err) => {
        console.warn('Rewarded ad failed to show:', err);
        void finish({
          rewarded: false,
          unavailable: true,
          adUnitId,
          message: 'Unable to display advertisement right now. You can continue playing for free!',
        });
      });

      handles.push(rewardHandle, dismissedHandle, failedToLoadHandle, failedToShowHandle);

      const options: RewardAdOptions = {
        adId: adUnitId,
        isTesting: !isRealAdMobId(ENV_REWARDED_ID, 'unit'),
        ssv: {
          userId,
          customData: rewardNonce,
        },
      };

      await AdMob.prepareRewardVideoAd(options);
      await AdMob.showRewardVideoAd();
    } catch (err) {
      console.warn('Rewarded ad error:', err);
      await finish({
        rewarded: false,
        unavailable: true,
        adUnitId,
        message: 'No rewarded advertisement is available right now. Please try again later!',
      });
    }
  });
}
