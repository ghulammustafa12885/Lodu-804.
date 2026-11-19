import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const protocols = (req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((p) => p.trim());
  if (protocols.includes('vite-hmr')) {
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

app.use(express.json({ limit: '2mb' }));

// CORS headers supporting HTTPS web origins and Capacitor Android WebView
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Lightweight IP rate limiter to prevent abuse & replay floods
const ipRateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(maxRequests: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${req.baseUrl || req.path.split('/').slice(0, 3).join('/')}:${ip}`;
    const now = Date.now();
    const bucket = ipRateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      ipRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count++;
    if (bucket.count > maxRequests) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });
    }
    return next();
  };
}

app.use('/api', rateLimit(240, 60_000));

interface TokenState {
  id: number;
  step: number; // -1 = yard, 0..50 = track, 51..55 = home stretch, 56 = home
  feroDone?: number;
}

interface Player {
  id: string;
  slot: number; // 0: Green, 1: Red, 2: Yellow, 3: Blue
  name: string;
  photo: string;
  color: 'green' | 'red' | 'yellow' | 'blue';
  isHost: boolean;
  connected: boolean;
  tokens: TokenState[];
  tokensHome: number;
  stars: number; // Virtual stars earned from verified rewarded ads (zero cash value)
}

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderPhoto: string;
  color: 'green' | 'red' | 'yellow' | 'blue';
  text: string;
  time: string;
}

interface RoomGame {
  hostId: string;
  status: 'lobby' | 'playing' | 'ended';
  currentTurn: number;
  diceValue: number | null;
  isRolling: boolean;
  diceRolled: boolean;
  movableTokenIds: number[];
  winnerSlot: number | null;
  runnerUpSlot: number | null;
  targetTokensToWin: number;
  feroCount: number;
  lastActionMessage: string;
  version: number;
  updatedAt: number;
}

interface Room {
  code: string;
  isPrivate: boolean;
  players: Player[];
  game: RoomGame;
  chat: ChatMessage[];

  hostId: string;
  status: 'lobby' | 'playing' | 'ended';
  currentTurn: number;
  diceValue: number | null;
  isRolling: boolean;
  diceRolled: boolean;
  movableTokenIds: number[];
  winnerSlot: number | null;
  runnerUpSlot: number | null;
  targetTokensToWin: number;
  feroCount: number;
  lastActionMessage: string;
  chatMessages: ChatMessage[];
  version: number;
  updatedAt: number;
  matchRecorded?: boolean;
}

interface PlayerStatsRecord {
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  lastMatchAt?: number;
}

interface MatchHistoryRecord {
  id: string;
  roomCode: string;
  won: boolean;
  winnerName: string;
  playerCount: number;
  feroCount: number;
  score: number;
  endedAt: number;
}

interface RewardNonceRecord {
  nonce: string;
  sig: string;
  playerId: string;
  accountKey: string;
  firebaseUid: string;
  createdAt: number;
  expiresAt: number;
  status: 'issued' | 'claimed';
  claimedAt?: number;
  transactionId?: string;
}

interface RewardTransactionRecord {
  id: string;
  playerId: string;
  firebaseUid: string;
  amount: number;
  source: 'admob_rewarded';
  adUnitId: string;
  nonce: string;
  ssvVerified: boolean;
  createdAt: number;
}

interface SsvReceiptRecord {
  transactionId: string;
  adUnit: string;
  userId?: string;
  keyId: string;
  timestamp: string;
  verifiedAt: number;
}

const REWARD_STARS_PER_AD = 20;
const INITIAL_PLAYER_STARS = 0; // Free virtual stars earned strictly via verified rewarded ads
const MIN_AD_COOLDOWN_MS = 8_000;

function isSsvRequired(): boolean {
  return process.env.ADMOB_REQUIRE_SSV !== 'false';
}

function encodeRtdbKey(raw: string): string {
  return raw.replace(/[.#$\/\[\]]/g, '_').slice(0, 128);
}

// Persistent REWARD_HMAC_SECRET: uses REWARD_HMAC_SECRET env var, or persists once in Firebase RTDB
let cachedHmacSecret: string | null = process.env.REWARD_HMAC_SECRET?.trim() || null;

async function getRewardHmacSecret(): Promise<string | null> {
  const fromEnv = process.env.REWARD_HMAC_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) {
    cachedHmacSecret = fromEnv;
    return cachedHmacSecret;
  }
  if (cachedHmacSecret) return cachedHmacSecret;
  if (!isFirebaseAdminConfigured()) return null;

  const secretPath = 'serverLedger/secrets/rewardHmacSecret';
  const existing = await rtdbGetWithEtag<string>(secretPath);
  if (existing.ok && typeof existing.value === 'string' && existing.value.length >= 32) {
    cachedHmacSecret = existing.value;
    return cachedHmacSecret;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  const saved = await rtdbPutIfMatch(secretPath, generated, existing.etag || 'null_etag');
  if (saved.ok) {
    cachedHmacSecret = generated;
    return cachedHmacSecret;
  }
  if (saved.conflict) {
    const reload = await rtdbGetWithEtag<string>(secretPath);
    if (reload.ok && typeof reload.value === 'string' && reload.value.length >= 32) {
      cachedHmacSecret = reload.value;
      return cachedHmacSecret;
    }
  }
  return null;
}

function signRewardNonce(secret: string, nonce: string, uid: string, issuedAt: number): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${nonce}:${uid}:${issuedAt}`)
    .digest('hex');
}

// Firebase Service Account OAuth2 Token Cache (server-side ONLY — NEVER exposed to frontend/APK)
let cachedAdminToken: { token: string; expiresAt: number } | null = null;

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getFirebaseDbUrl(): string {
  return (
    process.env.FIREBASE_DATABASE_URL?.trim() ||
    process.env.VITE_FIREBASE_DATABASE_URL?.trim() ||
    'https://ludo-804-default-rtdb.firebaseio.com'
  ).replace(/\/+$/, '');
}

function getFirebaseWebApiKey(): string {
  const key = (
    process.env.FIREBASE_WEB_API_KEY?.trim() ||
    process.env.VITE_FIREBASE_API_KEY?.trim() ||
    ''
  ).trim();
  if (!key || key === 'YOUR_API_KEY' || key.toUpperCase().includes('REPLACE_')) return '';
  return key;
}

function isFirebaseAdminConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() ||
      (process.env.FIREBASE_CLIENT_EMAIL?.trim() && process.env.FIREBASE_PRIVATE_KEY?.trim())
  );
}

function isFirebaseAuthConfigured(): boolean {
  return Boolean(getFirebaseWebApiKey());
}

async function getFirebaseAdminAccessToken(): Promise<string | null> {
  if (cachedAdminToken && Date.now() < cachedAdminToken.expiresAt - 60_000) {
    return cachedAdminToken.token;
  }

  let clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim() || '';
  let privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim() || '';

  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      clientEmail = parsed.client_email || clientEmail;
      privateKey = parsed.private_key || privateKey;
    } catch {
      return null;
    }
  }
  if (!clientEmail || !privateKey) return null;

  privateKey = privateKey.replace(/\\n/g, '\n');
  const tokenUrl =
    process.env.FIREBASE_OAUTH_TOKEN_URL?.trim() || 'https://oauth2.googleapis.com/token';
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope:
        'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
      aud: tokenUrl,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signingInput = `${header}.${claimSet}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = base64UrlEncode(signer.sign(privateKey));

  try {
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${signingInput}.${signature}`,
      }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    cachedAdminToken = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
    };
    return json.access_token;
  } catch {
    return null;
  }
}

async function rtdbGetWithEtag<T>(
  rtdbPath: string
): Promise<{ ok: boolean; value: T | null; etag: string | null }> {
  const token = await getFirebaseAdminAccessToken();
  if (!token) return { ok: false, value: null, etag: null };
  const url = `${getFirebaseDbUrl()}/${rtdbPath}.json?access_token=${encodeURIComponent(token)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'X-Firebase-ETag': 'true' },
    });
    if (!resp.ok) return { ok: false, value: null, etag: null };
    const etag = resp.headers.get('ETag');
    const value = (await resp.json()) as T | null;
    return { ok: true, value, etag };
  } catch {
    return { ok: false, value: null, etag: null };
  }
}

async function rtdbPutIfMatch<T>(
  rtdbPath: string,
  value: T,
  etag: string
): Promise<{ ok: boolean; conflict: boolean }> {
  const token = await getFirebaseAdminAccessToken();
  if (!token) return { ok: false, conflict: false };
  const url = `${getFirebaseDbUrl()}/${rtdbPath}.json?access_token=${encodeURIComponent(token)}`;
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': etag,
      },
      body: JSON.stringify(value),
    });
    if (resp.status === 412) {
      return { ok: false, conflict: true };
    }
    return { ok: resp.ok, conflict: false };
  } catch {
    return { ok: false, conflict: false };
  }
}

async function rtdbPut<T>(rtdbPath: string, value: T): Promise<boolean> {
  const token = await getFirebaseAdminAccessToken();
  if (!token) return false;
  const url = `${getFirebaseDbUrl()}/${rtdbPath}.json?access_token=${encodeURIComponent(token)}`;
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function getPersistentPlayerState(firebaseUid: string): Promise<{
  stars: number;
  transactions: RewardTransactionRecord[];
  stats: PlayerStatsRecord;
  matchHistory: MatchHistoryRecord[];
  configured: boolean;
}> {
  const emptyStats: PlayerStatsRecord = { matchesPlayed: 0, matchesWon: 0, matchesLost: 0 };
  if (!isFirebaseAdminConfigured()) {
    return {
      stars: INITIAL_PLAYER_STARS,
      transactions: [],
      stats: emptyStats,
      matchHistory: [],
      configured: false,
    };
  }

  const cleanUid = encodeRtdbKey(firebaseUid);
  const starsPath = `users/${cleanUid}/stars`;
  const txPath = `rewardTransactions/${cleanUid}`;
  const statsPath = `users/${cleanUid}/stats`;
  const historyPath = `matchHistory/${cleanUid}`;

  const [starsSnap, txSnap, statsSnap, historySnap] = await Promise.all([
    rtdbGetWithEtag<number>(starsPath),
    rtdbGetWithEtag<Record<string, RewardTransactionRecord>>(txPath),
    rtdbGetWithEtag<PlayerStatsRecord>(statsPath),
    rtdbGetWithEtag<Record<string, MatchHistoryRecord>>(historyPath),
  ]);

  const stars = typeof starsSnap.value === 'number' && starsSnap.value >= 0 ? starsSnap.value : 0;
  const txs =
    txSnap.value && typeof txSnap.value === 'object'
      ? Object.values(txSnap.value).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      : [];
  const rawStats = statsSnap.value;
  const stats: PlayerStatsRecord = {
    matchesPlayed: typeof rawStats?.matchesPlayed === 'number' ? rawStats.matchesPlayed : 0,
    matchesWon: typeof rawStats?.matchesWon === 'number' ? rawStats.matchesWon : 0,
    matchesLost: typeof rawStats?.matchesLost === 'number' ? rawStats.matchesLost : 0,
    lastMatchAt: typeof rawStats?.lastMatchAt === 'number' ? rawStats.lastMatchAt : undefined,
  };
  const matchHistory =
    historySnap.value && typeof historySnap.value === 'object'
      ? Object.values(historySnap.value)
          .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
          .slice(0, 10)
      : [];

  return { stars, transactions: txs.slice(0, 20), stats, matchHistory, configured: true };
}

async function recordMatchOutcomeToRtdb(room: Room): Promise<void> {
  if (!isFirebaseAdminConfigured() || room.status !== 'ended' || room.matchRecorded) return;
  room.matchRecorded = true;

  const matchId = encodeRtdbKey(`match_${room.code}_${Date.now()}`);
  const winnerPlayer = room.players.find((p) => p.slot === room.winnerSlot);

  await Promise.all(
    room.players.map(async (player) => {
      const cleanUid = encodeRtdbKey(player.id);
      if (!cleanUid || cleanUid.startsWith('empty_slot_')) return;

      const didWin = player.slot === room.winnerSlot;
      const statsPath = `users/${cleanUid}/stats`;
      for (let attempt = 0; attempt < 4; attempt++) {
        const snap = await rtdbGetWithEtag<PlayerStatsRecord>(statsPath);
        const cur = snap.value || { matchesPlayed: 0, matchesWon: 0, matchesLost: 0 };
        const next: PlayerStatsRecord = {
          matchesPlayed: (typeof cur.matchesPlayed === 'number' ? cur.matchesPlayed : 0) + 1,
          matchesWon: (typeof cur.matchesWon === 'number' ? cur.matchesWon : 0) + (didWin ? 1 : 0),
          matchesLost: (typeof cur.matchesLost === 'number' ? cur.matchesLost : 0) + (didWin ? 0 : 1),
          lastMatchAt: Date.now(),
        };
        const putRes = await rtdbPutIfMatch(statsPath, next, snap.etag || 'null_etag');
        if (putRes.ok || !putRes.conflict) break;
      }

      await rtdbPut(`matchHistory/${cleanUid}/${matchId}`, {
        id: matchId,
        roomCode: room.code,
        won: didWin,
        winnerName: winnerPlayer?.name || 'Winner',
        playerCount: room.players.length,
        feroCount: room.feroCount,
        score: calculatePlayerScore(player),
        endedAt: Date.now(),
      });
    })
  );
}

// Verify Firebase ID token via Firebase Identity Toolkit when Web API Key is configured
async function verifyFirebaseIdToken(idToken: string | undefined): Promise<string | null> {
  if (!idToken || typeof idToken !== 'string' || !idToken.trim()) return null;
  const webApiKey = getFirebaseWebApiKey();
  if (!webApiKey) return null;

  const lookupBase =
    process.env.FIREBASE_AUTH_LOOKUP_URL?.trim() ||
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

  try {
    const resp = await fetch(`${lookupBase}?key=${encodeURIComponent(webApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: idToken.trim() }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { users?: Array<{ localId?: string }> };
    return data.users?.[0]?.localId || null;
  } catch {
    return null;
  }
}

function extractBearerToken(req: express.Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  if (typeof req.body?.firebaseIdToken === 'string' && req.body.firebaseIdToken.trim()) {
    return req.body.firebaseIdToken.trim();
  }
  return undefined;
}

// Google AdMob SSV Public Verifier Keys Cache
let admobKeyCache: { keys: Record<string, string>; fetchedAt: number } | null = null;
async function getAdMobVerifierPublicKey(keyId: string): Promise<string | null> {
  const now = Date.now();
  const keysUrl =
    process.env.ADMOB_VERIFIER_KEYS_URL?.trim() ||
    'https://gstatic.com/admob/reward/verifier-keys.json';
  if (!admobKeyCache || now - admobKeyCache.fetchedAt > 3600_000) {
    try {
      const resp = await fetch(keysUrl);
      if (resp.ok) {
        const json = (await resp.json()) as { keys?: Array<{ keyId: number; pem: string }> };
        const map: Record<string, string> = {};
        for (const item of json.keys || []) {
          map[String(item.keyId)] = item.pem;
        }
        admobKeyCache = { keys: map, fetchedAt: now };
      }
    } catch {
      // keep stale cache if network transient
    }
  }
  return admobKeyCache?.keys[keyId] || null;
}

const rooms = new Map<string, Room>();
const clientRooms = new Map<
  WebSocket,
  { roomCode: string; playerId: string; verifiedUid: string }
>();

const CHAT_SPAM_WINDOW_MS = 10_000;
const CHAT_MAX_IN_WINDOW = 5;
const CHAT_MIN_GAP_MS = 900;
const CHAT_DUPLICATE_WINDOW_MS = 8_000;
const chatSpamTracker = new Map<
  string,
  { timestamps: number[]; lastText: string; lastTextAt: number }
>();

function sanitizeChatText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 250);
}

function checkChatSpam(
  uid: string,
  text: string,
  now: number = Date.now()
): { allowed: boolean; error?: string } {
  const clean = text.trim();
  if (!clean) {
    return { allowed: false, error: 'Message cannot be empty.' };
  }
  const entry = chatSpamTracker.get(uid) || { timestamps: [], lastText: '', lastTextAt: 0 };
  const recent = entry.timestamps.filter((t) => now - t < CHAT_SPAM_WINDOW_MS);
  const lastTs = recent[recent.length - 1] || 0;

  if (now - lastTs < CHAT_MIN_GAP_MS) {
    return { allowed: false, error: 'Sending messages too fast. Please wait a moment.' };
  }
  if (recent.length >= CHAT_MAX_IN_WINDOW) {
    return { allowed: false, error: 'Chat rate limit reached (max 5 messages per 10 seconds).' };
  }
  if (
    entry.lastText &&
    entry.lastText.toLowerCase() === clean.toLowerCase() &&
    now - entry.lastTextAt < CHAT_DUPLICATE_WINDOW_MS
  ) {
    return { allowed: false, error: 'Duplicate spam message blocked.' };
  }

  recent.push(now);
  chatSpamTracker.set(uid, { timestamps: recent, lastText: clean, lastTextAt: now });
  return { allowed: true };
}

function hasOtherOpenRoomSocket(roomCode: string, verifiedUid: string): boolean {
  for (const [sock, info] of clientRooms.entries()) {
    if (
      info.roomCode === roomCode &&
      info.verifiedUid === verifiedUid &&
      sock.readyState === WebSocket.OPEN
    ) {
      return true;
    }
  }
  return false;
}

async function persistChatMessageToRtdb(roomCode: string, msg: ChatMessage): Promise<void> {
  if (!isFirebaseAdminConfigured()) return;
  await rtdbPut(`rooms/${encodeRtdbKey(roomCode)}/chat/${encodeRtdbKey(msg.id)}`, {
    id: msg.id,
    senderUid: msg.senderId,
    senderName: msg.senderName,
    color: msg.color,
    text: msg.text,
    createdAt: Date.now(),
    time: msg.time,
  });
}

function createInitialTokens(): TokenState[] {
  return [
    { id: 0, step: -1, feroDone: 0 },
    { id: 1, step: -1, feroDone: 0 },
    { id: 2, step: -1, feroDone: 0 },
    { id: 3, step: -1, feroDone: 0 },
  ];
}

function normalizeLoadedRoom(raw: any, codeFallback?: string): Room | null {
  if (!raw || typeof raw !== 'object') return null;
  const code = (raw.code || codeFallback || '').toString().trim().toUpperCase();
  if (!code) return null;

  const rawPlayers: any[] = Array.isArray(raw.players)
    ? raw.players
    : raw.players && typeof raw.players === 'object'
      ? Object.values(raw.players)
      : [];

  const players: Player[] = rawPlayers.map((p: any, idx: number) => {
    const rawTokens: any[] = Array.isArray(p?.tokens)
      ? p.tokens
      : p?.tokens && typeof p.tokens === 'object'
        ? Object.values(p.tokens)
        : createInitialTokens();
    const tokens: TokenState[] = [0, 1, 2, 3].map((tid) => {
      const found = rawTokens.find((t: any) => Number(t?.id) === tid) || rawTokens[tid];
      return {
        id: tid,
        step: typeof found?.step === 'number' ? found.step : -1,
        feroDone: typeof found?.feroDone === 'number' ? found.feroDone : 0,
      };
    });
    return {
      id: (p?.id || `p_${idx}`).toString(),
      slot: typeof p?.slot === 'number' ? p.slot : idx,
      name: (p?.name || `Player ${idx + 1}`).toString(),
      photo: typeof p?.photo === 'string' ? p.photo : '',
      color: p?.color || COLOR_ORDER[typeof p?.slot === 'number' ? p.slot : idx] || 'green',
      isHost: Boolean(p?.isHost),
      connected: Boolean(p?.connected),
      tokens,
      tokensHome: tokens.filter((t) => t.step === 56).length,
      stars: typeof p?.stars === 'number' ? p.stars : 0,
    };
  });

  const rawChat: any[] = Array.isArray(raw.chatMessages)
    ? raw.chatMessages
    : Array.isArray(raw.chat)
      ? raw.chat
      : raw.chatMessages && typeof raw.chatMessages === 'object'
        ? Object.values(raw.chatMessages)
        : [];

  const movableTokenIds: number[] = Array.isArray(raw.movableTokenIds)
    ? raw.movableTokenIds.map(Number)
    : [];

  const status: 'lobby' | 'playing' | 'ended' =
    raw.status === 'playing' || raw.status === 'ended' ? raw.status : 'lobby';

  const hostId = (raw.hostId || players.find((p) => p.isHost)?.id || players[0]?.id || '').toString();
  const room: Room = {
    code,
    isPrivate: raw.isPrivate !== false,
    players,
    hostId,
    status,
    currentTurn: typeof raw.currentTurn === 'number' ? raw.currentTurn : players[0]?.slot ?? 0,
    diceValue: typeof raw.diceValue === 'number' ? raw.diceValue : null,
    isRolling: false, // clear transient roll animation on restore
    diceRolled: Boolean(raw.diceRolled),
    movableTokenIds,
    winnerSlot: typeof raw.winnerSlot === 'number' ? raw.winnerSlot : null,
    runnerUpSlot: typeof raw.runnerUpSlot === 'number' ? raw.runnerUpSlot : null,
    targetTokensToWin: typeof raw.targetTokensToWin === 'number' ? raw.targetTokensToWin : 4,
    feroCount: typeof raw.feroCount === 'number' ? raw.feroCount : 1,
    lastActionMessage: (raw.lastActionMessage || '').toString(),
    chatMessages: rawChat,
    chat: rawChat,
    version: typeof raw.version === 'number' ? raw.version : 1,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    matchRecorded: Boolean(raw.matchRecorded),
    game: {
      hostId,
      status,
      currentTurn: typeof raw.currentTurn === 'number' ? raw.currentTurn : players[0]?.slot ?? 0,
      diceValue: typeof raw.diceValue === 'number' ? raw.diceValue : null,
      isRolling: false,
      diceRolled: Boolean(raw.diceRolled),
      movableTokenIds,
      winnerSlot: typeof raw.winnerSlot === 'number' ? raw.winnerSlot : null,
      runnerUpSlot: typeof raw.runnerUpSlot === 'number' ? raw.runnerUpSlot : null,
      targetTokensToWin: typeof raw.targetTokensToWin === 'number' ? raw.targetTokensToWin : 4,
      feroCount: typeof raw.feroCount === 'number' ? raw.feroCount : 1,
      lastActionMessage: (raw.lastActionMessage || '').toString(),
      version: typeof raw.version === 'number' ? raw.version : 1,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    },
  };
  return room;
}

async function persistRoomToRtdb(room: Room): Promise<boolean> {
  if (!isFirebaseAdminConfigured()) return false;
  syncRoomGame(room);
  return rtdbPut(`serverLedger/activeRooms/${encodeRtdbKey(room.code)}`, room);
}

async function getOrLoadRoom(codeRaw: string): Promise<Room | null> {
  const code = codeRaw.trim().toUpperCase();
  if (!code) return null;
  const cached = rooms.get(code);
  if (cached) return cached;

  if (!isFirebaseAdminConfigured()) return null;
  const snap = await rtdbGetWithEtag<any>(`serverLedger/activeRooms/${encodeRtdbKey(code)}`);
  if (!snap.ok || !snap.value) return null;

  const loaded = normalizeLoadedRoom(snap.value, code);
  if (!loaded) return null;
  rooms.set(code, loaded);
  if (loaded.status === 'playing' && loaded.diceRolled && loaded.movableTokenIds.length === 0) {
    scheduleNoMoveTurnAdvance(loaded, loaded.version);
  }
  return loaded;
}

async function hydrateActiveRoomsOnBoot(): Promise<void> {
  if (!isFirebaseAdminConfigured()) return;
  const snap = await rtdbGetWithEtag<Record<string, any>>('serverLedger/activeRooms');
  if (!snap.ok || !snap.value || typeof snap.value !== 'object') return;
  let restoredCount = 0;
  for (const [codeKey, rawRoom] of Object.entries(snap.value)) {
    const loaded = normalizeLoadedRoom(rawRoom, codeKey);
    if (loaded) {
      rooms.set(loaded.code, loaded);
      restoredCount++;
      if (loaded.status === 'playing' && loaded.diceRolled && loaded.movableTokenIds.length === 0) {
        scheduleNoMoveTurnAdvance(loaded, loaded.version);
      }
    }
  }
  if (restoredCount > 0) {
    console.log(`Restored ${restoredCount} persistent room(s) from Firebase RTDB.`);
  }
}

function generate4DigitRoomCode(): string {
  for (let i = 0; i < 9000; i++) {
    const code = crypto.randomInt(1000, 10000).toString();
    if (code !== '8040' && !rooms.has(code)) {
      return code;
    }
  }
  return crypto.randomInt(1000, 10000).toString();
}

function syncRoomGame(room: Room) {
  room.game.hostId = room.hostId;
  room.game.status = room.status;
  room.game.currentTurn = room.currentTurn;
  room.game.diceValue = room.diceValue;
  room.game.isRolling = room.isRolling;
  room.game.diceRolled = room.diceRolled;
  room.game.movableTokenIds = room.movableTokenIds;
  room.game.winnerSlot = room.winnerSlot;
  room.game.runnerUpSlot = room.runnerUpSlot;
  room.game.targetTokensToWin = room.targetTokensToWin;
  room.game.feroCount = room.feroCount;
  room.game.lastActionMessage = room.lastActionMessage;
  room.game.version = room.version;
  room.game.updatedAt = room.updatedAt;
  room.chat = room.chatMessages;
}

const COLOR_ORDER: ('green' | 'red' | 'yellow' | 'blue')[] = ['green', 'red', 'yellow', 'blue'];

const SAFE_TRACK_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const COLOR_START_INDEX: Record<string, number> = {
  green: 0,
  yellow: 13,
  blue: 26,
  red: 39,
};

function getTrackIndex(color: string, step: number): number | null {
  if (step >= 0 && step <= 50) {
    const startIdx = COLOR_START_INDEX[color];
    return (startIdx + step) % 52;
  }
  return null;
}

function getNextTurnSlot(room: Room, currentSlot: number): number {
  const occupiedSlots = new Set(room.players.map((p) => p.slot));
  if (occupiedSlots.size === 0) return 0;
  for (let offset = 1; offset <= 4; offset++) {
    const candidate = (currentSlot + offset) % 4;
    if (occupiedSlots.has(candidate)) {
      return candidate;
    }
  }
  return currentSlot;
}

function calculatePlayerScore(player: Player): number {
  return (
    player.tokensHome * 100 +
    player.tokens.reduce((acc, t) => acc + (t.step > 0 ? t.step : 0), 0)
  );
}

function finalize10FeroWinner(room: Room) {
  const ranked = [...room.players].sort(
    (a, b) => calculatePlayerScore(b) - calculatePlayerScore(a) || a.slot - b.slot
  );
  const top = ranked[0];
  const second = ranked[1];
  room.status = 'ended';
  room.diceRolled = false;
  room.diceValue = null;
  room.movableTokenIds = [];
  if (top) {
    room.winnerSlot = top.slot;
    room.runnerUpSlot = second ? second.slot : null;
    room.lastActionMessage = `10 FERO COMPLETE! WINNER - 804: ${top.name} (${calculatePlayerScore(top)} pts)!`;
  }
}

function getInitialRoom(
  code: string,
  hostId: string,
  hostName: string,
  hostPhoto: string,
  isPrivate: boolean = true
): Room {
  const initChat: ChatMessage[] = [
    {
      id: 'msg_init',
      senderId: 'system',
      senderName: '804 System',
      senderPhoto: '',
      color: 'green',
      text: `Room ${code} created. Real Online Multiplayer ready!`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ];

  const now = Date.now();
  const safeHostId = (hostId || `host_${now}`).toString().slice(0, 64);
  const safeHostName = (hostName || 'Kaptaan 804').toString().slice(0, 24);
  const safeHostPhoto = typeof hostPhoto === 'string' ? hostPhoto.slice(0, 350000) : '';

  const initPlayers: Player[] = [
    {
      id: safeHostId,
      slot: 0,
      name: safeHostName,
      photo: safeHostPhoto,
      color: 'green',
      isHost: true,
      connected: true,
      tokens: createInitialTokens(),
      tokensHome: 0,
      stars: INITIAL_PLAYER_STARS,
    },
  ];

  const initGame: RoomGame = {
    hostId: safeHostId,
    status: 'lobby',
    currentTurn: 0,
    diceValue: null,
    isRolling: false,
    diceRolled: false,
    movableTokenIds: [],
    winnerSlot: null,
    runnerUpSlot: null,
    targetTokensToWin: 4,
    feroCount: 1,
    lastActionMessage: `Room ${code} created. Share 4-digit code ${code} with friends to join!`,
    version: 1,
    updatedAt: now,
  };

  return {
    code,
    isPrivate,
    players: initPlayers,
    game: initGame,
    chat: initChat,
    hostId: safeHostId,
    status: 'lobby',
    currentTurn: 0,
    diceValue: null,
    isRolling: false,
    diceRolled: false,
    movableTokenIds: [],
    winnerSlot: null,
    runnerUpSlot: null,
    targetTokensToWin: 4,
    feroCount: 1,
    chatMessages: initChat,
    lastActionMessage: initGame.lastActionMessage,
    version: 1,
    updatedAt: now,
    matchRecorded: false,
  };
}

function broadcastToRoom(roomCode: string, payload: any) {
  const msg = JSON.stringify(payload);
  for (const [ws, info] of clientRooms.entries()) {
    if (info.roomCode === roomCode && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function calculateMovableTokens(player: Player, dice: number): number[] {
  if (dice < 1 || dice > 6) return [];
  const movable: number[] = [];
  player.tokens.forEach((t) => {
    if (t.step === 56) return;
    if (t.step === -1) {
      if (dice === 6) movable.push(t.id);
    } else if (t.step + dice <= 56) {
      movable.push(t.id);
    }
  });
  return movable;
}

function creditAuthoritativeStarsInRooms(playerId: string, newBalance: number) {
  for (const room of rooms.values()) {
    const p = room.players.find((pl) => pl.id === playerId);
    if (p) {
      p.stars = newBalance;
      room.version++;
      room.updatedAt = Date.now();
      syncRoomGame(room);
      void persistRoomToRtdb(room);
      broadcastToRoom(room.code, { type: 'ROOM_UPDATE', room });
    }
  }
}

// ======================= REST API ENDPOINTS =======================

app.get('/api/health', async (_req, res) => {
  const hmacConfigured = Boolean(
    (process.env.REWARD_HMAC_SECRET?.trim()?.length || 0) >= 16 || isFirebaseAdminConfigured()
  );
  res.json({
    status: 'ok',
    time: Date.now(),
    persistentDatabase: isFirebaseAdminConfigured() ? 'firebase_rtdb' : 'unconfigured',
    firebaseAdminConfigured: isFirebaseAdminConfigured(),
    firebaseAuthConfigured: isFirebaseAuthConfigured(),
    hmacSecretConfigured: hmacConfigured,
    ssvRequired: isSsvRequired(),
  });
});

app.get('/api/export/source-zip', (_req, res) => {
  const candidates = [
    path.resolve(process.cwd(), 'release', 'ludo-804-android-source.zip'),
    path.resolve(__dirname, 'release', 'ludo-804-android-source.zip'),
  ];
  const zipPath = candidates.find((p) => fs.existsSync(p));
  if (!zipPath) {
    return res.status(404).json({ error: 'Source ZIP archive not generated yet.' });
  }
  res.download(zipPath, 'ludo-804-android-source.zip');
});

app.get('/api/player/:playerId/stars', async (req, res) => {
  const requestedId = req.params.playerId?.trim();
  if (!requestedId) return res.status(400).json({ error: 'playerId required' });

  const token = extractBearerToken(req);
  if (!isFirebaseAuthConfigured()) {
    return res.status(503).json({
      ok: false,
      firebaseAuthConfigured: false,
      persistentDatabaseConfigured: isFirebaseAdminConfigured(),
      stars: 0,
      transactions: [],
      error: 'Firebase Authentication (API Key) is not configured.',
    });
  }

  const verifiedUid = await verifyFirebaseIdToken(token);
  if (!verifiedUid) {
    return res.status(401).json({
      ok: false,
      error: 'Firebase Authentication required to access player stars.',
    });
  }
  if (requestedId !== 'me' && requestedId !== verifiedUid) {
    return res.status(403).json({
      ok: false,
      error: 'Access denied: cannot query another player account.',
    });
  }

  const state = await getPersistentPlayerState(verifiedUid);
  return res.json({
    ok: true,
    playerId: verifiedUid,
    firebaseUid: verifiedUid,
    persistentDatabaseConfigured: state.configured,
    stars: state.stars,
    stats: state.stats,
    matchHistory: state.matchHistory,
    transactions: state.transactions,
  });
});

app.get('/api/player/:playerId/history', async (req, res) => {
  const requestedId = req.params.playerId?.trim();
  if (!requestedId) return res.status(400).json({ error: 'playerId required' });

  if (!isFirebaseAuthConfigured() || !isFirebaseAdminConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Firebase Auth and Persistent RTDB must be configured.',
    });
  }

  const verifiedUid = await verifyFirebaseIdToken(extractBearerToken(req));
  if (!verifiedUid) {
    return res.status(401).json({ ok: false, error: 'Firebase Authentication required.' });
  }
  if (requestedId !== 'me' && requestedId !== verifiedUid) {
    return res.status(403).json({ ok: false, error: 'Access denied.' });
  }

  const state = await getPersistentPlayerState(verifiedUid);
  return res.json({
    ok: true,
    playerId: verifiedUid,
    stats: state.stats,
    matchHistory: state.matchHistory,
  });
});

// Step 1 of Secure AdMob Reward Flow: Requires Verified Firebase Auth + Persistent Firebase RTDB
app.post('/api/rewards/prepare', rateLimit(20, 60_000), async (req, res) => {
  if (!isFirebaseAdminConfigured()) {
    return res.status(503).json({
      ok: false,
      persistentDatabaseConfigured: false,
      error:
        'Persistent Firebase Database is not configured on the server. Set FIREBASE_SERVICE_ACCOUNT_JSON to enable verified rewarded star credits.',
    });
  }
  if (!isFirebaseAuthConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Firebase Authentication is not configured on the server.',
    });
  }

  const token = extractBearerToken(req);
  const verifiedUid = await verifyFirebaseIdToken(token);
  if (!verifiedUid) {
    return res.status(401).json({
      ok: false,
      error: 'Firebase Authentication is required before earning stars.',
    });
  }

  const hmacSecret = await getRewardHmacSecret();
  if (!hmacSecret) {
    return res.status(503).json({
      ok: false,
      error: 'Persistent REWARD_HMAC_SECRET is unavailable.',
    });
  }

  const accountKey = encodeRtdbKey(verifiedUid);
  const cooldownSnap = await rtdbGetWithEtag<number>(`serverLedger/cooldowns/${accountKey}`);
  const lastClaim = typeof cooldownSnap.value === 'number' ? cooldownSnap.value : 0;
  if (Date.now() - lastClaim < MIN_AD_COOLDOWN_MS) {
    const waitSec = Math.ceil((MIN_AD_COOLDOWN_MS - (Date.now() - lastClaim)) / 1000);
    return res.status(429).json({
      ok: false,
      error: `Please wait ${waitSec}s before starting another rewarded advertisement.`,
    });
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const sig = signRewardNonce(hmacSecret, nonce, verifiedUid, now);

  const rec: RewardNonceRecord = {
    nonce,
    sig,
    playerId: verifiedUid,
    accountKey,
    firebaseUid: verifiedUid,
    createdAt: now,
    expiresAt: now + 5 * 60_000,
    status: 'issued',
  };

  const saved = await rtdbPut(`serverLedger/nonces/${nonce}`, rec);
  if (!saved) {
    return res.status(502).json({
      ok: false,
      error: 'Unable to persist reward session in Firebase Realtime Database.',
    });
  }

  return res.json({
    ok: true,
    rewardNonce: nonce,
    rewardAmount: REWARD_STARS_PER_AD,
    firebaseUid: verifiedUid,
    expiresAt: rec.expiresAt,
  });
});

// Google AdMob Server-Side Verification (SSV) Callback Webhook
app.get('/api/admob/ssv', async (req, res) => {
  try {
    if (!isFirebaseAdminConfigured()) {
      return res.status(503).send('Firebase Service Account required for SSV persistence');
    }

    const rawUrl = req.originalUrl || '';
    const queryIdx = rawUrl.indexOf('?');
    if (queryIdx === -1) return res.status(400).send('Missing query string');

    const queryString = rawUrl.slice(queryIdx + 1);
    const sigMarker = '&signature=';
    const sigPos = queryString.indexOf(sigMarker);
    if (sigPos === -1) return res.status(400).send('Missing signature');

    const contentToVerify = queryString.slice(0, sigPos);
    const keyId = req.query.key_id?.toString() || '';
    const signature = req.query.signature?.toString() || '';
    const transactionId = req.query.transaction_id?.toString() || '';
    const customData = req.query.custom_data?.toString() || '';
    const userId = req.query.user_id?.toString() || '';
    const adUnit = req.query.ad_unit?.toString() || '';
    const timestamp = req.query.timestamp?.toString() || '';

    if (!keyId || !signature || !transactionId) {
      return res.status(400).send('Invalid SSV parameters');
    }

    const pem = await getAdMobVerifierPublicKey(keyId);
    if (!pem) {
      return res.status(400).send('Unknown AdMob verifier key_id');
    }

    const verifier = crypto.createVerify('SHA256');
    verifier.update(contentToVerify);
    const sigBuf = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const isValid = verifier.verify(pem, sigBuf);

    if (!isValid) {
      return res.status(403).send('Invalid AdMob SSV signature');
    }

    const ssvTxKey = encodeRtdbKey(transactionId);
    const txCheck = await rtdbGetWithEtag<{ recordedAt: number }>(
      `serverLedger/ssvTransactions/${ssvTxKey}`
    );
    if (txCheck.value) {
      return res.status(200).send('OK'); // Idempotent ack
    }

    // Atomic conditional insert to prevent SSV transaction_id replay
    const txPut = await rtdbPutIfMatch(
      `serverLedger/ssvTransactions/${ssvTxKey}`,
      { recordedAt: Date.now(), nonce: customData, adUnit, userId },
      txCheck.etag || 'null_etag'
    );
    if (!txPut.ok) {
      return res.status(200).send('OK');
    }

    if (customData) {
      const receipt: SsvReceiptRecord = {
        transactionId,
        adUnit,
        userId,
        keyId,
        timestamp,
        verifiedAt: Date.now(),
      };
      await rtdbPut(`serverLedger/ssvReceipts/${encodeRtdbKey(customData)}`, receipt);
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('AdMob SSV webhook error:', err);
    return res.status(500).send('SSV verification error');
  }
});

// Step 2 of Secure AdMob Reward Flow: Strictly requires Verified Firebase UID + AdMob SSV + Single-Use CAS
app.post('/api/rewards/claim', rateLimit(25, 60_000), async (req, res) => {
  if (!isFirebaseAdminConfigured()) {
    return res.status(503).json({
      ok: false,
      persistentDatabaseConfigured: false,
      error: 'Persistent Firebase Database is not configured on the server.',
    });
  }
  if (!isFirebaseAuthConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Firebase Authentication is not configured on the server.',
    });
  }

  const token = extractBearerToken(req);
  const verifiedUid = await verifyFirebaseIdToken(token);
  if (!verifiedUid) {
    return res.status(401).json({
      ok: false,
      error: 'Firebase Authentication is required to claim rewarded stars.',
    });
  }

  const hmacSecret = await getRewardHmacSecret();
  if (!hmacSecret) {
    return res.status(503).json({
      ok: false,
      error: 'Persistent REWARD_HMAC_SECRET is unavailable.',
    });
  }

  const { rewardNonce, adUnitId } = req.body || {};
  if (!rewardNonce) {
    return res.status(400).json({ ok: false, error: 'rewardNonce is required.' });
  }

  const cleanNonce = encodeRtdbKey(rewardNonce.toString());
  const noncePath = `serverLedger/nonces/${cleanNonce}`;

  const nonceSnap = await rtdbGetWithEtag<RewardNonceRecord>(noncePath);
  const rec = nonceSnap.value;
  if (!nonceSnap.ok || !rec || !nonceSnap.etag) {
    return res.status(400).json({ ok: false, error: 'Invalid or unknown reward nonce.' });
  }
  if (rec.firebaseUid !== verifiedUid) {
    return res.status(403).json({ ok: false, error: 'Reward nonce does not belong to this Firebase user.' });
  }
  if (rec.sig !== signRewardNonce(hmacSecret, rec.nonce, rec.firebaseUid, rec.createdAt)) {
    return res.status(403).json({ ok: false, error: 'Reward nonce signature check failed.' });
  }
  if (rec.status === 'claimed') {
    return res.status(409).json({
      ok: false,
      duplicate: true,
      error: 'Duplicate reward claim blocked. Stars for this ad were already credited.',
    });
  }
  if (Date.now() > rec.expiresAt) {
    return res.status(400).json({ ok: false, error: 'Reward session expired. Watch a fresh ad.' });
  }

  // Mandatory Google AdMob SSV Check
  const ssvSnap = await rtdbGetWithEtag<SsvReceiptRecord>(`serverLedger/ssvReceipts/${cleanNonce}`);
  const ssvReceipt = ssvSnap.value;
  if (isSsvRequired() && !ssvReceipt) {
    return res.status(403).json({
      ok: false,
      ssvPending: true,
      error: 'Waiting for Google AdMob Server-Side Verification (SSV) confirmation...',
    });
  }
  if (ssvReceipt?.userId && ssvReceipt.userId !== verifiedUid) {
    return res.status(403).json({
      ok: false,
      error: 'AdMob SSV user mismatch detected.',
    });
  }

  const claimedTxId = ssvReceipt?.transactionId || `tx_${crypto.randomBytes(8).toString('hex')}`;
  const updatedNonce: RewardNonceRecord = {
    ...rec,
    status: 'claimed',
    claimedAt: Date.now(),
    transactionId: claimedTxId,
  };

  // Atomic ETag Compare-And-Swap prevents race-condition duplicate claims
  const claimLock = await rtdbPutIfMatch(noncePath, updatedNonce, nonceSnap.etag);
  if (claimLock.conflict) {
    return res.status(409).json({
      ok: false,
      duplicate: true,
      error: 'Duplicate reward claim blocked concurrently.',
    });
  }
  if (!claimLock.ok) {
    return res.status(502).json({ ok: false, error: 'Failed to lock reward claim in Firebase.' });
  }

  const cleanUidKey = encodeRtdbKey(verifiedUid);
  const starsPath = `users/${cleanUidKey}/stars`;
  const txBasePath = `rewardTransactions/${cleanUidKey}`;

  // Atomic CAS balance increment in Firebase RTDB
  let newBalance = 0;
  let balanceSaved = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const balSnap = await rtdbGetWithEtag<number>(starsPath);
    const curBal = typeof balSnap.value === 'number' && balSnap.value >= 0 ? balSnap.value : 0;
    const candidateBal = curBal + REWARD_STARS_PER_AD;
    const putRes = await rtdbPutIfMatch(starsPath, candidateBal, balSnap.etag || 'null_etag');
    if (putRes.ok) {
      newBalance = candidateBal;
      balanceSaved = true;
      break;
    }
    if (!putRes.conflict) break;
  }

  if (!balanceSaved) {
    return res.status(502).json({
      ok: false,
      error: 'Failed to update persistent balance in Firebase Realtime Database.',
    });
  }

  const txRecord: RewardTransactionRecord = {
    id: encodeRtdbKey(claimedTxId),
    playerId: verifiedUid,
    firebaseUid: verifiedUid,
    amount: REWARD_STARS_PER_AD,
    source: 'admob_rewarded',
    adUnitId: (ssvReceipt?.adUnit || adUnitId || '').toString().slice(0, 64),
    nonce: rec.nonce,
    ssvVerified: Boolean(ssvReceipt),
    createdAt: Date.now(),
  };

  await Promise.all([
    rtdbPut(`${txBasePath}/${txRecord.id}`, txRecord),
    rtdbPut(`serverLedger/cooldowns/${cleanUidKey}`, Date.now()),
  ]);

  creditAuthoritativeStarsInRooms(verifiedUid, newBalance);

  return res.json({
    ok: true,
    amount: REWARD_STARS_PER_AD,
    newBalance,
    firebaseSynced: true,
    ssvVerified: Boolean(ssvReceipt),
    transaction: txRecord,
    message: `+${REWARD_STARS_PER_AD} Free Virtual Stars credited to Firebase!`,
  });
});

// ======================= PERSISTENT AUTHENTICATED MULTIPLAYER ENDPOINTS =======================

app.get(['/api/room/:code', '/api/rooms/:code'], async (req, res) => {
  if (!isFirebaseAuthConfigured() || !isFirebaseAdminConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Firebase Auth and Persistent RTDB must be configured for online rooms.',
    });
  }
  const verifiedUid = await verifyFirebaseIdToken(extractBearerToken(req));
  if (!verifiedUid) {
    return res.status(401).json({ ok: false, error: 'Firebase Authentication required.' });
  }

  const code = req.params.code.trim().toUpperCase();
  const room = await getOrLoadRoom(code);
  if (!room) {
    return res.status(404).json({ ok: false, error: `Room ${code} not found` });
  }
  if (room.isPrivate && !room.players.some((p) => p.id === verifiedUid)) {
    return res.status(403).json({ ok: false, error: 'Access denied to private room.' });
  }
  return res.json(room);
});

app.get('/api/rooms/:code/players', async (req, res) => {
  if (!isFirebaseAuthConfigured() || !isFirebaseAdminConfigured()) {
    return res.status(503).json({ error: 'Firebase Auth and Persistent RTDB required.' });
  }
  const verifiedUid = await verifyFirebaseIdToken(extractBearerToken(req));
  if (!verifiedUid) return res.status(401).json({ error: 'Firebase Authentication required.' });

  const code = req.params.code.trim().toUpperCase();
  const room = await getOrLoadRoom(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.isPrivate && !room.players.some((p) => p.id === verifiedUid)) {
    return res.status(403).json({ error: 'Access denied to private room.' });
  }
  return res.json(room.players);
});

app.get('/api/rooms/:code/game', async (req, res) => {
  if (!isFirebaseAuthConfigured() || !isFirebaseAdminConfigured()) {
    return res.status(503).json({ error: 'Firebase Auth and Persistent RTDB required.' });
  }
  const verifiedUid = await verifyFirebaseIdToken(extractBearerToken(req));
  if (!verifiedUid) return res.status(401).json({ error: 'Firebase Authentication required.' });

  const code = req.params.code.trim().toUpperCase();
  const room = await getOrLoadRoom(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.isPrivate && !room.players.some((p) => p.id === verifiedUid)) {
    return res.status(403).json({ error: 'Access denied to private room.' });
  }
  return res.json(room.game);
});

app.get('/api/rooms/:code/chat', async (req, res) => {
  if (!isFirebaseAuthConfigured() || !isFirebaseAdminConfigured()) {
    return res.status(503).json({ error: 'Firebase Auth and Persistent RTDB required.' });
  }
  const verifiedUid = await verifyFirebaseIdToken(extractBearerToken(req));
  if (!verifiedUid) return res.status(401).json({ error: 'Firebase Authentication required.' });

  const code = req.params.code.trim().toUpperCase();
  const room = await getOrLoadRoom(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.isPrivate && !room.players.some((p) => p.id === verifiedUid)) {
    return res.status(403).json({ error: 'Access denied to private room.' });
  }
  return res.json(room.chat);
});

app.post(['/api/room/create', '/api/rooms/create'], async (req, res) => {
  if (!isFirebaseAdminConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Persistent Firebase Database is not configured for online rooms.',
    });
  }
  if (!isFirebaseAuthConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Firebase Authentication is not configured on the server.',
    });
  }

  const verifiedUid = await verifyFirebaseIdToken(extractBearerToken(req));
  if (!verifiedUid) {
    return res.status(401).json({
      ok: false,
      error: 'Firebase Authentication is required to create an online room.',
    });
  }

  const { code, hostId, hostName, hostPhoto, isPrivate = true } = req.body || {};
  if (hostId && hostId !== verifiedUid) {
    return res.status(403).json({
      ok: false,
      error: 'Identity spoofing blocked: hostId does not match authenticated Firebase UID.',
    });
  }

  let roomCode = code
    ? code.toString().trim().toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6)
    : '';
  if (!roomCode || roomCode === 'AUTO' || roomCode === 'NEW') {
    roomCode = generate4DigitRoomCode();
  } else {
    const existing = await getOrLoadRoom(roomCode);
    if (existing) {
      if (existing.hostId !== verifiedUid) {
        roomCode = generate4DigitRoomCode();
      } else {
        return res.json(existing);
      }
    }
  }

  const room = getInitialRoom(roomCode, verifiedUid, hostName, hostPhoto, Boolean(isPrivate));
  const state = await getPersistentPlayerState(verifiedUid);
  if (room.players[0]) {
    room.players[0].stars = state.stars;
  }
  rooms.set(roomCode, room);
  const persisted = await persistRoomToRtdb(room);
  if (!persisted) {
    rooms.delete(roomCode);
    return res.status(502).json({
      ok: false,
      error: 'Failed to persist online room in Firebase Realtime Database.',
    });
  }
  return res.json(room);
});

app.post(['/api/room/join', '/api/rooms/join'], async (req, res) => {
  if (!isFirebaseAdminConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Persistent Firebase Database is not configured for online rooms.',
    });
  }
  if (!isFirebaseAuthConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Firebase Authentication is not configured on the server.',
    });
  }

  const verifiedUid = await verifyFirebaseIdToken(extractBearerToken(req));
  if (!verifiedUid) {
    return res.status(401).json({
      ok: false,
      error: 'Firebase Authentication is required to join an online room.',
    });
  }

  const { code, playerId } = req.body || {};
  if (playerId && playerId !== verifiedUid) {
    return res.status(403).json({
      ok: false,
      error: 'Identity spoofing blocked: playerId must match authenticated Firebase UID.',
    });
  }

  const roomCode = (code || '').toString().trim().toUpperCase();
  if (!roomCode) {
    return res.status(400).json({ ok: false, error: 'Room code is required.' });
  }

  let room = await getOrLoadRoom(roomCode);
  // Only public quick-match room '8040' auto-initializes when nobody has hosted one yet
  if (!room && roomCode === '8040') {
    room = getInitialRoom(
      '8040',
      verifiedUid,
      req.body?.name || 'Kaptaan 804',
      req.body?.photo || '',
      false
    );
    rooms.set('8040', room);
    await persistRoomToRtdb(room);
  }

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: `Room ${roomCode} does not exist. Ask Host (Mobile 1) to create the room first.`,
    });
  }

  const existing = room.players.find((p) => p.id === verifiedUid);
  if (!existing && room.status === 'playing') {
    return res.status(403).json({
      ok: false,
      error: `Match in Room ${roomCode} has already started.`,
    });
  }
  if (!existing && room.players.length >= 4) {
    return res.status(409).json({
      ok: false,
      error: `Room ${roomCode} is already full (4/4 players).`,
    });
  }

  const playerState = await getPersistentPlayerState(verifiedUid);

  if (existing) {
    if (req.body?.name) existing.name = req.body.name.toString().slice(0, 24);
    if (typeof req.body?.photo === 'string') existing.photo = req.body.photo.slice(0, 350000);
    existing.stars = playerState.stars;
    existing.connected = true;
    await persistRoomToRtdb(room);
  } else {
    const takenSlots = new Set(room.players.map((p) => p.slot));
    let targetSlot = 0;
    for (let s = 0; s < 4; s++) {
      if (!takenSlots.has(s)) {
        targetSlot = s;
        break;
      }
    }
    const newPlayer: Player = {
      id: verifiedUid,
      slot: targetSlot,
      name: (req.body?.name || `Player ${targetSlot + 1}`).toString().slice(0, 24),
      photo: typeof req.body?.photo === 'string' ? req.body.photo.slice(0, 350000) : '',
      color: COLOR_ORDER[targetSlot],
      isHost: room.players.length === 0,
      connected: true,
      tokens: createInitialTokens(),
      tokensHome: 0,
      stars: playerState.stars,
    };
    room.players.push(newPlayer);
    room.players.sort((a, b) => a.slot - b.slot);
    room.version++;
    room.updatedAt = Date.now();
    syncRoomGame(room);
    await persistRoomToRtdb(room);
    broadcastToRoom(roomCode, { type: 'ROOM_UPDATE', room });
  }

  return res.json({ ok: true, room });
});

app.post(['/api/room/:code/action', '/api/rooms/:code/action'], async (req, res) => {
  if (!isFirebaseAdminConfigured() || !isFirebaseAuthConfigured()) {
    return res.status(503).json({ ok: false, error: 'Firebase Auth and RTDB required.' });
  }

  const verifiedUid = await verifyFirebaseIdToken(extractBearerToken(req));
  if (!verifiedUid) {
    return res.status(401).json({ ok: false, error: 'Firebase Authentication required.' });
  }

  const code = req.params.code.trim().toUpperCase();
  const room = await getOrLoadRoom(code);
  if (!room) return res.status(404).json({ ok: false, error: 'Room not found' });

  const { type, payload } = req.body || {};
  if (payload?.playerId && payload.playerId !== verifiedUid) {
    return res.status(403).json({
      ok: false,
      error: 'Identity spoofing blocked: actor must match authenticated Firebase UID.',
    });
  }

  const result = processRoomAction(room, type, { ...(payload || {}), playerId: verifiedUid });
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  if (room.status === 'ended' && !room.matchRecorded) {
    await recordMatchOutcomeToRtdb(room);
  }
  await persistRoomToRtdb(room);
  if (type === 'CHAT_MESSAGE') {
    const latestMsg = room.chatMessages[room.chatMessages.length - 1];
    if (latestMsg && latestMsg.senderId === verifiedUid) {
      void persistChatMessageToRtdb(code, latestMsg);
    }
  }
  broadcastToRoom(code, { type: 'ROOM_UPDATE', room });
  return res.json({ ok: true, version: room.version, room });
});

function scheduleNoMoveTurnAdvance(room: Room, expectedVersion: number) {
  setTimeout(async () => {
    const liveRoom = rooms.get(room.code);
    if (!liveRoom || liveRoom.status !== 'playing' || liveRoom.version !== expectedVersion) {
      return;
    }

    const firstSlot = liveRoom.players[0]?.slot ?? 0;
    const nextSlot = getNextTurnSlot(liveRoom, liveRoom.currentTurn);

    let didEndMatch = false;
    if (nextSlot === firstSlot && liveRoom.feroCount >= 10) {
      finalize10FeroWinner(liveRoom);
      didEndMatch = true;
    } else {
      liveRoom.currentTurn = nextSlot;
      liveRoom.diceRolled = false;
      liveRoom.diceValue = null;
      liveRoom.movableTokenIds = [];

      if (nextSlot === firstSlot) {
        liveRoom.feroCount = Math.min(10, liveRoom.feroCount + 1);
      }

      const nextP = liveRoom.players.find((p) => p.slot === nextSlot);
      const feroTxt =
        liveRoom.feroCount === 10 ? 'FINAL FERO 10!' : `Fero ${liveRoom.feroCount}/10`;
      liveRoom.lastActionMessage = `[${feroTxt}] Now ${nextP?.name || 'Player'}'s turn (${
        nextP?.color.toUpperCase() || ''
      }). Roll dice!`;
    }

    liveRoom.version++;
    liveRoom.updatedAt = Date.now();
    syncRoomGame(liveRoom);
    if (didEndMatch && !liveRoom.matchRecorded) {
      await recordMatchOutcomeToRtdb(liveRoom);
    }
    await persistRoomToRtdb(liveRoom);

    broadcastToRoom(liveRoom.code, {
      type: 'ROOM_UPDATE',
      room: liveRoom,
    });
  }, 1100);
}

function processRoomAction(
  room: Room,
  type: string,
  data: any
): { ok: boolean; error?: string } {
  const actorId = data?.playerId?.toString();

  if (type === 'START_MATCH') {
    if (!actorId || actorId !== room.hostId) {
      return { ok: false, error: 'Only the room host can start the match.' };
    }
    if (room.status === 'playing') {
      return { ok: false, error: 'Match is already in progress.' };
    }

    room.players.sort((a, b) => a.slot - b.slot);
    room.players.forEach((p) => {
      p.tokens = createInitialTokens();
      p.tokensHome = 0;
    });

    const firstSlot = room.players[0]?.slot ?? 0;
    const firstPlayer = room.players.find((p) => p.slot === firstSlot);

    room.status = 'playing';
    room.matchRecorded = false;
    room.currentTurn = firstSlot;
    room.diceValue = null;
    room.diceRolled = false;
    room.isRolling = false;
    room.movableTokenIds = [];
    room.winnerSlot = null;
    room.runnerUpSlot = null;
    room.feroCount = 1;
    room.lastActionMessage = `10 Fero Match Started! ${firstPlayer?.name || 'Host'} rolls first.`;
    room.version++;
    room.updatedAt = Date.now();
    syncRoomGame(room);
    return { ok: true };
  }

  if (type === 'DICE_ROLLED') {
    if (room.status !== 'playing') {
      return { ok: false, error: 'Match is not active.' };
    }
    if (room.diceRolled) {
      return { ok: false, error: 'Dice has already been rolled for this turn.' };
    }

    const curPlayer = room.players.find((p) => p.slot === room.currentTurn);
    if (!curPlayer) {
      return { ok: false, error: 'No active player on current turn.' };
    }
    if (actorId !== curPlayer.id) {
      return { ok: false, error: `Not your turn. Waiting for ${curPlayer.name}.` };
    }

    const rollValue = crypto.randomInt(1, 7);

    room.isRolling = false;
    room.diceValue = rollValue;
    room.diceRolled = true;

    const movable = calculateMovableTokens(curPlayer, rollValue);
    room.movableTokenIds = movable;

    if (movable.length === 0) {
      room.lastActionMessage = `${curPlayer.name} rolled ${rollValue}. No moves available.`;
    } else {
      const bonusText = rollValue === 6 ? ' (Bonus roll on 6!)' : '';
      room.lastActionMessage = `${curPlayer.name} rolled ${rollValue}! Select a token to move.${bonusText}`;
    }

    room.version++;
    room.updatedAt = Date.now();
    syncRoomGame(room);

    if (movable.length === 0) {
      scheduleNoMoveTurnAdvance(room, room.version);
    }

    return { ok: true };
  }

  if (type === 'MOVE_TOKEN') {
    if (room.status !== 'playing') {
      return { ok: false, error: 'Match is not active.' };
    }
    if (!room.diceRolled || room.diceValue === null) {
      return { ok: false, error: 'Roll the dice before moving a token.' };
    }

    const curPlayer = room.players.find((p) => p.slot === room.currentTurn);
    if (!curPlayer) {
      return { ok: false, error: 'Active player not found.' };
    }
    if (actorId !== curPlayer.id) {
      return { ok: false, error: `Not your turn. Waiting for ${curPlayer.name}.` };
    }

    const { tokenId } = data;
    if (!room.movableTokenIds.includes(tokenId)) {
      return { ok: false, error: 'Selected token is not a legal move for this dice roll.' };
    }

    const token = curPlayer.tokens.find((t) => t.id === tokenId);
    if (!token) {
      return { ok: false, error: 'Token not found.' };
    }

    const stepVal = room.diceValue;
    const targetStep = token.step === -1 ? 0 : token.step + stepVal;
    if (targetStep > 56) {
      return { ok: false, error: 'Move exceeds home square.' };
    }

    token.step = targetStep;

    const cutNames: string[] = [];
    const attackerTrackIdx = getTrackIndex(curPlayer.color, targetStep);

    if (attackerTrackIdx !== null && !SAFE_TRACK_INDICES.has(attackerTrackIdx)) {
      room.players.forEach((opp) => {
        if (opp.slot !== curPlayer.slot) {
          opp.tokens.forEach((oppToken) => {
            const oppTrackIdx = getTrackIndex(opp.color, oppToken.step);
            if (oppTrackIdx === attackerTrackIdx) {
              oppToken.step = -1;
              cutNames.push(opp.name);
            }
          });
        }
      });
    }

    const homeCount = curPlayer.tokens.filter((t) => t.step === 56).length;
    curPlayer.tokensHome = homeCount;

    if (homeCount >= 4) {
      room.status = 'ended';
      room.winnerSlot = curPlayer.slot;
      room.diceRolled = false;
      room.diceValue = null;
      room.movableTokenIds = [];

      let runnerUp: Player | null = null;
      let maxScore = -1;
      room.players.forEach((p) => {
        if (p.slot !== curPlayer.slot) {
          const score = calculatePlayerScore(p);
          if (score > maxScore) {
            maxScore = score;
            runnerUp = p;
          }
        }
      });

      if (runnerUp) {
        room.runnerUpSlot = (runnerUp as Player).slot;
      }

      room.lastActionMessage = `WINNER - 804! ${curPlayer.name} brought all 4 tokens home!`;
    } else {
      const getsBonus = stepVal === 6 || cutNames.length > 0 || targetStep === 56;

      if (getsBonus) {
        room.diceRolled = false;
        room.diceValue = null;
        room.movableTokenIds = [];
        if (cutNames.length > 0) {
          room.lastActionMessage = `BOOM! ${curPlayer.name} CUT ${cutNames[0]}'s token! +1 BONUS ROLL!`;
        } else if (targetStep === 56) {
          room.lastActionMessage = `VICTORY! ${curPlayer.name}'s token reached HOME 804! +1 BONUS ROLL!`;
        } else {
          room.lastActionMessage = `SIX! ${curPlayer.name} earned a BONUS ROLL!`;
        }
      } else {
        const firstSlot = room.players[0]?.slot ?? 0;
        const nextSlot = getNextTurnSlot(room, room.currentTurn);

        if (nextSlot === firstSlot && room.feroCount >= 10) {
          finalize10FeroWinner(room);
        } else {
          room.currentTurn = nextSlot;
          room.diceRolled = false;
          room.diceValue = null;
          room.movableTokenIds = [];

          if (nextSlot === firstSlot) {
            room.feroCount = Math.min(10, room.feroCount + 1);
          }

          const nextP = room.players.find((p) => p.slot === nextSlot);
          const feroTxt =
            room.feroCount === 10 ? 'FINAL FERO 10!' : `Fero ${room.feroCount}/10`;
          room.lastActionMessage = `[${feroTxt}] Now ${nextP?.name}'s turn (${nextP?.color.toUpperCase()}). Roll dice!`;
        }
      }
    }

    room.version++;
    room.updatedAt = Date.now();
    syncRoomGame(room);
    return { ok: true };
  }

  if (type === 'UPDATE_PROFILE') {
    if (!actorId) return { ok: false, error: 'playerId is required' };
    const targetPlayer = room.players.find((p) => p.id === actorId);
    if (!targetPlayer) return { ok: false, error: 'Player not found in room' };

    if (typeof data.name === 'string' && data.name.trim()) {
      targetPlayer.name = data.name.trim().slice(0, 24);
    }
    if (typeof data.photo === 'string') {
      targetPlayer.photo = data.photo.slice(0, 350000);
    }
    room.version++;
    room.updatedAt = Date.now();
    syncRoomGame(room);
    return { ok: true };
  }

  if (type === 'CHAT_MESSAGE') {
    if (!actorId) return { ok: false, error: 'playerId is required' };
    const member = room.players.find((p) => p.id === actorId);
    if (!member) return { ok: false, error: 'Only room members can send chat messages.' };
    const text = sanitizeChatText(data.text);
    const spamCheck = checkChatSpam(member.id, text);
    if (!spamCheck.allowed) {
      return { ok: false, error: spamCheck.error };
    }

    const msgId = (data.id || `msg_${Date.now()}`).toString().slice(0, 64);
    if (!room.chatMessages.some((m) => m.id === msgId)) {
      const sanitizedMsg: ChatMessage = {
        id: msgId,
        senderId: member.id,
        senderName: member.name,
        senderPhoto: member.photo,
        color: member.color,
        text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      room.chatMessages.push(sanitizedMsg);
      if (room.chatMessages.length > 80) room.chatMessages.shift();
      room.version++;
      room.updatedAt = Date.now();
      syncRoomGame(room);
    }
    return { ok: true };
  }

  return { ok: false, error: `Unknown action: ${type}` };
}

// ======================= WEBSOCKET HANDLERS (FIREBASE AUTHENTICATED) =======================

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      const { type, roomCode } = data;
      const code = roomCode?.toString().trim().toUpperCase();
      if (!code) return;

      if (type === 'JOIN_ROOM' || type === 'REJOIN_ROOM') {
        if (!isFirebaseAdminConfigured() || !isFirebaseAuthConfigured()) {
          ws.send(
            JSON.stringify({
              type: 'AUTH_ERROR',
              error: 'Server Firebase Auth / Persistent RTDB is not configured.',
            })
          );
          return;
        }

        const { playerId, firebaseIdToken, name, photo } = data;
        const verifiedUid = await verifyFirebaseIdToken(firebaseIdToken);
        if (!verifiedUid) {
          ws.send(
            JSON.stringify({
              type: 'AUTH_ERROR',
              error: 'Firebase Authentication required to join multiplayer room.',
            })
          );
          return;
        }
        if (playerId && playerId !== verifiedUid) {
          ws.send(
            JSON.stringify({
              type: 'ACTION_ERROR',
              error: 'Identity spoofing blocked: playerId must match authenticated Firebase UID.',
            })
          );
          return;
        }

        let room = await getOrLoadRoom(code);
        if (!room) {
          if (code === '8040') {
            room = getInitialRoom('8040', verifiedUid, name, photo, false);
            rooms.set('8040', room);
          } else {
            ws.send(
              JSON.stringify({
                type: 'ROOM_NOT_FOUND',
                error: `Room ${code} does not exist. Ask the host to create the room first.`,
              })
            );
            return;
          }
        }

        const activeRoom = room;
        const playerState = await getPersistentPlayerState(verifiedUid);
        const existingPlayer = activeRoom.players.find((p) => p.id === verifiedUid);
        if (existingPlayer) {
          existingPlayer.connected = true;
          existingPlayer.stars = playerState.stars;
          if (typeof name === 'string' && name.trim()) {
            existingPlayer.name = name.trim().slice(0, 24);
          }
          if (typeof photo === 'string') {
            existingPlayer.photo = photo.slice(0, 350000);
          }

          activeRoom.chatMessages.push({
            id: 'rejoin_' + Date.now(),
            senderId: 'system',
            senderName: '804 System',
            senderPhoto: '',
            color: existingPlayer.color,
            text: `${existingPlayer.name} connected to match.`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          });
        } else if (activeRoom.status === 'playing') {
          ws.send(
            JSON.stringify({
              type: 'ACTION_ERROR',
              error: `Room ${code} is already in an active match.`,
            })
          );
          return;
        } else if (activeRoom.players.length < 4) {
          const takenSlots = new Set(activeRoom.players.map((p) => p.slot));
          let targetSlot = 0;
          for (let s = 0; s < 4; s++) {
            if (!takenSlots.has(s)) {
              targetSlot = s;
              break;
            }
          }

          const newPlayer: Player = {
            id: verifiedUid,
            slot: targetSlot,
            name: (name || `Player ${targetSlot + 1}`).toString().slice(0, 24),
            photo: typeof photo === 'string' ? photo.slice(0, 350000) : '',
            color: COLOR_ORDER[targetSlot],
            isHost: activeRoom.players.length === 0,
            connected: true,
            tokens: createInitialTokens(),
            tokensHome: 0,
            stars: playerState.stars,
          };
          activeRoom.players.push(newPlayer);
          activeRoom.players.sort((a, b) => a.slot - b.slot);

          activeRoom.chatMessages.push({
            id: 'join_' + Date.now(),
            senderId: 'system',
            senderName: '804 System',
            senderPhoto: '',
            color: newPlayer.color,
            text: `${newPlayer.name} joined as ${newPlayer.color.toUpperCase()}!`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          });
        } else {
          ws.send(
            JSON.stringify({ type: 'ACTION_ERROR', error: `Room ${code} is full (4/4 players).` })
          );
          return;
        }

        if (activeRoom.chatMessages.length > 80) {
          activeRoom.chatMessages.splice(0, activeRoom.chatMessages.length - 80);
        }

        activeRoom.version++;
        activeRoom.updatedAt = Date.now();
        syncRoomGame(activeRoom);
        await persistRoomToRtdb(activeRoom);

        const prevInfo = clientRooms.get(ws);
        if (prevInfo && prevInfo.roomCode !== code) {
          const prevRoom = rooms.get(prevInfo.roomCode);
          if (prevRoom) {
            const prevP = prevRoom.players.find((p) => p.id === prevInfo.verifiedUid);
            if (prevP) {
              prevP.connected = false;
              syncRoomGame(prevRoom);
              await persistRoomToRtdb(prevRoom);
              broadcastToRoom(prevInfo.roomCode, { type: 'ROOM_UPDATE', room: prevRoom });
            }
          }
        }
        clientRooms.set(ws, { roomCode: code, playerId: verifiedUid, verifiedUid });

        broadcastToRoom(code, {
          type: 'ROOM_UPDATE',
          room: activeRoom,
        });
        return;
      }

      // All gameplay/chat socket actions strictly require an authenticated socket bound to the room
      const bound = clientRooms.get(ws);
      if (!bound || bound.roomCode !== code) {
        ws.send(
          JSON.stringify({
            type: 'AUTH_ERROR',
            error: 'Socket is not authenticated in this room.',
          })
        );
        return;
      }
      if (data.playerId && data.playerId !== bound.verifiedUid) {
        ws.send(
          JSON.stringify({
            type: 'ACTION_ERROR',
            error: 'Identity spoofing blocked on WebSocket.',
          })
        );
        return;
      }

      const room = await getOrLoadRoom(code);
      if (!room) return;
      const actorId = bound.verifiedUid;

      if (type === 'ROLL_DICE_START') {
        if (room.status !== 'playing' || room.diceRolled) return;
        const curPlayer = room.players.find((p) => p.slot === room.currentTurn);
        if (!curPlayer || curPlayer.id !== actorId) {
          ws.send(JSON.stringify({ type: 'ACTION_ERROR', error: 'Not your turn to roll dice.' }));
          return;
        }

        room.isRolling = true;
        syncRoomGame(room);
        broadcastToRoom(code, {
          type: 'ROLL_DICE_ANIMATION',
          currentTurn: room.currentTurn,
        });
      } else if (type === 'DICE_ROLLED') {
        const result = processRoomAction(room, 'DICE_ROLLED', { ...data, playerId: actorId });
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'ACTION_ERROR', error: result.error }));
          return;
        }

        await persistRoomToRtdb(room);
        broadcastToRoom(code, {
          type: 'DICE_RESULT',
          diceValue: room.diceValue,
          currentTurn: room.currentTurn,
          movableTokenIds: room.movableTokenIds,
          lastActionMessage: room.lastActionMessage,
          room,
        });
      } else if (type === 'MOVE_TOKEN') {
        const result = processRoomAction(room, 'MOVE_TOKEN', { ...data, playerId: actorId });
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'ACTION_ERROR', error: result.error }));
          return;
        }
        if (room.status === 'ended' && !room.matchRecorded) {
          await recordMatchOutcomeToRtdb(room);
        }
        await persistRoomToRtdb(room);
        broadcastToRoom(code, {
          type: 'ROOM_UPDATE',
          room,
        });
      } else if (type === 'START_MATCH') {
        const result = processRoomAction(room, 'START_MATCH', { ...data, playerId: actorId });
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'ACTION_ERROR', error: result.error }));
          return;
        }
        await persistRoomToRtdb(room);
        broadcastToRoom(code, {
          type: 'ROOM_UPDATE',
          room,
        });
      } else if (type === 'UPDATE_PROFILE') {
        const result = processRoomAction(room, 'UPDATE_PROFILE', { ...data, playerId: actorId });
        if (result.ok) {
          await persistRoomToRtdb(room);
          broadcastToRoom(code, {
            type: 'ROOM_UPDATE',
            room,
          });
        }
      } else if (type === 'CHAT_MESSAGE') {
        const { message: chatMsg } = data;
        const member = room.players.find((p) => p.id === actorId);
        if (!member) {
          ws.send(
            JSON.stringify({
              type: 'ACTION_ERROR',
              error: 'Only room members can send chat messages.',
            })
          );
          return;
        }

        const cleanText = sanitizeChatText(chatMsg?.text);
        const spamCheck = checkChatSpam(member.id, cleanText);
        if (!spamCheck.allowed) {
          ws.send(
            JSON.stringify({
              type: 'ACTION_ERROR',
              error: spamCheck.error || 'Chat message blocked.',
            })
          );
          return;
        }

        const sanitizedMsg: ChatMessage = {
          id: (chatMsg?.id || `msg_${Date.now()}`).toString().slice(0, 64),
          senderId: member.id,
          senderName: member.name,
          senderPhoto: member.photo,
          color: member.color,
          text: cleanText,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };

        if (!room.chatMessages.some((m) => m.id === sanitizedMsg.id)) {
          room.chatMessages.push(sanitizedMsg);
          if (room.chatMessages.length > 80) {
            room.chatMessages.shift();
          }
          room.version++;
          room.updatedAt = Date.now();
          syncRoomGame(room);
          await Promise.all([
            persistRoomToRtdb(room),
            persistChatMessageToRtdb(code, sanitizedMsg),
          ]);
        }
        broadcastToRoom(code, {
          type: 'NEW_CHAT_MESSAGE',
          message: sanitizedMsg,
        });
      } else if (type === 'LEAVE_ROOM') {
        clientRooms.delete(ws);
        if (!hasOtherOpenRoomSocket(code, actorId)) {
          const p = room.players.find((pl) => pl.id === actorId);
          if (p && p.connected) {
            p.connected = false;
            room.lastActionMessage = `${p.name} left the room view. Waiting for reconnect...`;
            room.version++;
            room.updatedAt = Date.now();
            syncRoomGame(room);
            await persistRoomToRtdb(room);
            broadcastToRoom(code, {
              type: 'ROOM_UPDATE',
              room,
            });
          }
        }
      }
    } catch (err) {
      console.error('Server WS error:', err);
    }
  });

  ws.on('close', async () => {
    const info = clientRooms.get(ws);
    if (!info) return;
    clientRooms.delete(ws);

    if (hasOtherOpenRoomSocket(info.roomCode, info.verifiedUid)) {
      return;
    }

    const room = rooms.get(info.roomCode);
    if (room) {
      const activeRoom = room;
      const p = activeRoom.players.find((pl) => pl.id === info.verifiedUid);
      if (p) {
        p.connected = false;
        activeRoom.lastActionMessage = `${p.name} Disconnected. Waiting for reconnect...`;
        activeRoom.chatMessages.push({
          id: 'left_' + Date.now(),
          senderId: 'system',
          senderName: '804 System',
          senderPhoto: '',
          color: p.color,
          text: `${p.name} disconnected. (Can rejoin anytime)`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
        if (activeRoom.chatMessages.length > 80) {
          activeRoom.chatMessages.shift();
        }
        activeRoom.version++;
        activeRoom.updatedAt = Date.now();
        syncRoomGame(activeRoom);
        await persistRoomToRtdb(activeRoom);
        broadcastToRoom(info.roomCode, {
          type: 'ROOM_UPDATE',
          room: activeRoom,
        });
      }
    }
  });
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  await hydrateActiveRoomsOnBoot();

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
      plugins: [
        {
          name: 'ludo-disable-vite-hmr-ws-client',
          enforce: 'post',
          transform(code, id) {
            const cleanId = id.split('?')[0].replace(/\\/g, '/');
            if (!cleanId.endsWith('/vite/dist/client/client.mjs')) return null;
            const replaced = code
              .replace(
                /const createWebSocketModuleRunnerTransport = \([\s\S]*?\n\};\n/,
                'const createWebSocketModuleRunnerTransport = () => ({ connect() {}, disconnect() {}, send() {} });\n'
              )
              .replace(
                /createConnection:\s*\(\)\s*=>\s*new WebSocket\([^)]*\)/g,
                'createConnection: () => null'
              );
            return { code: replaced, map: null };
          },
        },
      ],
    });
    app.use(vite.middlewares);
  } else {
    const distDir = [
      path.resolve(process.cwd(), 'dist'),
      path.resolve(__dirname, 'dist'),
      path.resolve(__dirname, '..', 'dist'),
    ].find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(port, '0.0.0.0', () => {
    console.log(`LUDO 804 server running on http://0.0.0.0:${port}`);
  });
}

export {
  app,
  server,
  wss,
  startServer,
  processRoomAction,
  checkChatSpam,
  sanitizeChatText,
  calculateMovableTokens,
  createInitialTokens,
  calculatePlayerScore,
  getInitialRoom,
};

if (!process.env.LUDO_IMPORT_ONLY) {
  void startServer();
}
