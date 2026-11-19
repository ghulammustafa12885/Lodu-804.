// Firebase Config, Authentication, Realtime Database, Presence & Transaction Sync for LUDO 804
import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, Auth, User } from 'firebase/auth';
import {
  getDatabase,
  ref,
  set,
  get,
  onValue,
  onDisconnect,
  serverTimestamp,
  Database,
} from 'firebase/database';
import { MatchHistoryEntry, PlayerStats, RewardTransaction } from '../types/ludo';

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim() || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || 'ludo-804.firebaseapp.com',
  databaseURL:
    import.meta.env.VITE_FIREBASE_DATABASE_URL?.trim() || 'https://ludo-804-default-rtdb.firebaseio.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim() || 'ludo-804',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim() || 'ludo-804.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim() || '',
};

function isInvalidOrPlaceholder(val: string): boolean {
  const clean = val.trim();
  if (!clean) return true;
  const upper = clean.toUpperCase();
  return (
    upper.includes('YOUR_') ||
    upper.includes('REPLACE_') ||
    upper === 'UNDEFINED' ||
    upper === 'NULL'
  );
}

export function getMissingFirebaseKeys(): string[] {
  const missing: string[] = [];
  if (isInvalidOrPlaceholder(firebaseConfig.apiKey)) missing.push('VITE_FIREBASE_API_KEY');
  if (isInvalidOrPlaceholder(firebaseConfig.messagingSenderId)) {
    missing.push('VITE_FIREBASE_MESSAGING_SENDER_ID');
  }
  if (isInvalidOrPlaceholder(firebaseConfig.appId)) missing.push('VITE_FIREBASE_APP_ID');
  if (isInvalidOrPlaceholder(firebaseConfig.databaseURL) || !firebaseConfig.databaseURL.startsWith('https://')) {
    missing.push('VITE_FIREBASE_DATABASE_URL');
  }
  if (isInvalidOrPlaceholder(firebaseConfig.projectId)) missing.push('VITE_FIREBASE_PROJECT_ID');
  return missing;
}

export function isFirebaseConfigured(): boolean {
  return getMissingFirebaseKeys().length === 0;
}

export function getFirebaseConfigError(): string | null {
  const missing = getMissingFirebaseKeys();
  if (missing.length === 0) return null;
  return `Firebase not connected: missing ${missing.join(', ')}. Configure real Firebase credentials and enable Anonymous Sign-in.`;
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Database | null = null;

if (isFirebaseConfigured()) {
  try {
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getDatabase(app);
  } catch (err) {
    console.warn('Firebase initialization failed:', err);
    app = null;
    auth = null;
    db = null;
  }
}

export { app, auth, db };

export async function ensureFirebaseAuth(): Promise<User | null> {
  if (!auth || !db || !isFirebaseConfigured()) return null;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;

  if (auth.currentUser) {
    return auth.currentUser;
  }

  try {
    const cred = await signInAnonymously(auth);
    return cred.user;
  } catch (err) {
    console.warn('Firebase anonymous auth failed:', err);
    return null;
  }
}

export async function getFirebaseIdToken(): Promise<string | null> {
  const user = await ensureFirebaseAuth();
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

export function subscribeToAuthUser(callback: (user: User | null) => void): () => void {
  if (!auth || !isFirebaseConfigured()) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

export function subscribeToFirebaseConnection(callback: (connected: boolean) => void): () => void {
  if (!db || !auth || !isFirebaseConfigured()) {
    callback(false);
    return () => {};
  }
  try {
    const connRef = ref(db, '.info/connected');
    return onValue(connRef, (snap) => {
      callback(snap.val() === true && Boolean(auth?.currentUser));
    });
  } catch {
    callback(false);
    return () => {};
  }
}

export async function syncUserProfileToFirebase(profile: {
  name: string;
  photo: string;
  city: string;
}): Promise<boolean> {
  if (!db || !isFirebaseConfigured()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  try {
    const user = await ensureFirebaseAuth();
    if (!user) return false;
    await set(ref(db, `users/${user.uid}/profile`), {
      name: (profile.name || 'Kaptaan 804').slice(0, 24),
      photo: (profile.photo || '').slice(0, 350000),
      city: (profile.city || '').slice(0, 64),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (err) {
    console.warn('Firebase profile sync failed:', err);
    return false;
  }
}

export async function fetchUserProfileFromFirebase(
  uid: string
): Promise<{ name?: string; photo?: string; city?: string } | null> {
  if (!db || !isFirebaseConfigured() || !uid) return null;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;
  try {
    const snap = await get(ref(db, `users/${uid}/profile`));
    if (snap.exists() && typeof snap.val() === 'object') {
      return snap.val() as { name?: string; photo?: string; city?: string };
    }
    return null;
  } catch {
    return null;
  }
}

export function subscribeToFirebaseStats(
  uid: string,
  onUpdate: (stats: PlayerStats) => void
): () => void {
  if (!db || !isFirebaseConfigured() || !uid) return () => {};
  try {
    const statsRef = ref(db, `users/${uid}/stats`);
    return onValue(statsRef, (snap) => {
      const val = snap.val();
      if (val && typeof val === 'object') {
        onUpdate({
          matchesPlayed: typeof val.matchesPlayed === 'number' ? val.matchesPlayed : 0,
          matchesWon: typeof val.matchesWon === 'number' ? val.matchesWon : 0,
          matchesLost: typeof val.matchesLost === 'number' ? val.matchesLost : 0,
          lastMatchAt: typeof val.lastMatchAt === 'number' ? val.lastMatchAt : undefined,
        });
      }
    });
  } catch {
    return () => {};
  }
}

export function subscribeToFirebaseStars(
  uid: string,
  onUpdate: (stars: number, transactions: RewardTransaction[]) => void
): () => void {
  if (!db || !isFirebaseConfigured() || !uid) return () => {};
  try {
    let latestStars = 0;
    let latestTx: RewardTransaction[] = [];

    const starsRef = ref(db, `users/${uid}/stars`);
    const txRef = ref(db, `rewardTransactions/${uid}`);

    const unsubStars = onValue(starsRef, (snap) => {
      const val = snap.val();
      if (typeof val === 'number') {
        latestStars = val;
        onUpdate(latestStars, latestTx);
      }
    });

    const unsubTx = onValue(txRef, (snap) => {
      const val = snap.val();
      if (val && typeof val === 'object') {
        latestTx = Object.values(val) as RewardTransaction[];
        latestTx.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        onUpdate(latestStars, latestTx.slice(0, 20));
      }
    });

    return () => {
      unsubStars();
      unsubTx();
    };
  } catch {
    return () => {};
  }
}

export function subscribeToMatchHistory(
  uid: string,
  onUpdate: (history: MatchHistoryEntry[]) => void
): () => void {
  if (!db || !isFirebaseConfigured() || !uid) return () => {};
  try {
    const historyRef = ref(db, `matchHistory/${uid}`);
    return onValue(historyRef, (snap) => {
      const val = snap.val();
      if (val && typeof val === 'object') {
        const list = Object.values(val) as MatchHistoryEntry[];
        list.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
        onUpdate(list.slice(0, 10));
      } else {
        onUpdate([]);
      }
    });
  } catch {
    return () => {};
  }
}

export async function createRoom(
  customCode?: string | number,
  hostName: string = 'Kaptaan 804',
  isPrivate: boolean = true
): Promise<{ roomCode: string; synced: boolean; reason?: string }> {
  const roomCode = customCode
    ? customCode.toString().trim().toUpperCase()
    : Math.floor(1000 + Math.random() * 9000).toString();

  if (!db || !isFirebaseConfigured()) {
    return {
      roomCode,
      synced: false,
      reason: getFirebaseConfigError() || 'Firebase Realtime Database not configured.',
    };
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { roomCode, synced: false, reason: 'Device is offline.' };
  }

  try {
    const user = await ensureFirebaseAuth();
    if (!user) {
      return { roomCode, synced: false, reason: 'Firebase Anonymous Auth failed.' };
    }

    await set(ref(db, `rooms/${roomCode}`), {
      hostUid: user.uid,
      hostName: hostName.slice(0, 24),
      isPrivate,
      status: 'lobby',
      createdAt: serverTimestamp(),
      members: {
        [user.uid]: true,
      },
    });

    const presRef = ref(db, `presence/${roomCode}/${user.uid}`);
    await onDisconnect(presRef).remove();
    await set(presRef, { online: true, name: hostName.slice(0, 24), lastSeen: serverTimestamp() });

    return { roomCode, synced: true };
  } catch (err: any) {
    return { roomCode, synced: false, reason: err?.message || 'Firebase RTDB write error' };
  }
}

export async function joinRoom(
  roomCode: string | number,
  playerName: string = 'Player',
  onAlert?: (msg: string) => void
): Promise<{ success: boolean; message: string }> {
  const codeStr = roomCode.toString().trim().toUpperCase();

  if (!db || !isFirebaseConfigured()) {
    const msg = getFirebaseConfigError() || 'Firebase RTDB is not configured.';
    if (onAlert) onAlert(msg);
    return { success: false, message: msg };
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const msg = 'Offline: Cannot reach Firebase Realtime Database.';
    if (onAlert) onAlert(msg);
    return { success: false, message: msg };
  }

  try {
    const user = await ensureFirebaseAuth();
    if (!user) {
      const msg = 'Firebase Authentication failed.';
      if (onAlert) onAlert(msg);
      return { success: false, message: msg };
    }

    // Write member entry first (database.rules.json enforces room exists AND status === 'lobby')
    // so non-members cannot read private rooms prior to joining.
    await set(ref(db, `rooms/${codeStr}/members/${user.uid}`), true);

    const snapshot = await get(ref(db, `rooms/${codeStr}`));
    if (!snapshot.exists()) {
      const msg = 'Room Code Galat Hai!';
      if (onAlert) onAlert(msg);
      return { success: false, message: msg };
    }

    const presRef = ref(db, `presence/${codeStr}/${user.uid}`);
    await onDisconnect(presRef).remove();
    await set(presRef, { online: true, name: playerName.slice(0, 24), lastSeen: serverTimestamp() });

    const msg = 'Room Join Ho Gaya!';
    if (onAlert) onAlert(msg);
    return { success: true, message: msg };
  } catch (err: any) {
    const msg =
      err?.code === 'PERMISSION_DENIED'
        ? 'Room Code Galat Hai or Match Already Started!'
        : err?.message || 'Failed to connect to Firebase room.';
    if (onAlert) onAlert(msg);
    return { success: false, message: msg };
  }
}

export function subscribeToFirebaseRoom(roomCode: string, callback: (data: any) => void): () => void {
  if (!db || !isFirebaseConfigured()) return () => {};
  if (typeof navigator !== 'undefined' && !navigator.onLine) return () => {};

  try {
    const roomRef = ref(db, 'rooms/' + roomCode.toUpperCase());
    return onValue(
      roomRef,
      (snapshot) => {
        if (snapshot.exists()) {
          callback(snapshot.val());
        }
      },
      (error) => {
        console.warn('Firebase RTDB listener error:', error);
      }
    );
  } catch (err) {
    console.warn('Firebase RTDB subscribe error:', err);
    return () => {};
  }
}

export async function leaveFirebaseRoomPresence(roomCode: string): Promise<void> {
  if (!db || !auth?.currentUser || !isFirebaseConfigured()) return;
  try {
    const cleanCode = roomCode.toString().trim().toUpperCase();
    await set(ref(db, `presence/${cleanCode}/${auth.currentUser.uid}`), null);
  } catch {
    // ignore cleanup failures when already offline
  }
}
