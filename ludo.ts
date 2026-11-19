export type PlayerColor = 'green' | 'red' | 'yellow' | 'blue';

export interface Token {
  id: number; // 0, 1, 2, 3
  step: number; // -1: Yard, 0..50: Outer Track, 51..55: Home Stretch, 56: Reached Home
  feroDone?: number;
}

export interface Player {
  id: string;
  slot: number; // 0: Green, 1: Red, 2: Yellow, 3: Blue
  name: string;
  photo: string;
  color: PlayerColor;
  isHost: boolean;
  connected: boolean;
  tokens: Token[];
  tokensHome: number;
  stars: number; // Free virtual entertainment stars (zero cash value)
}

export type GameMode = 'online' | 'pass_and_play';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderPhoto: string;
  color: PlayerColor;
  text: string;
  time: string;
}

export interface BoardCellCoord {
  row: number;
  col: number;
}

export interface PlayerStats {
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  lastMatchAt?: number;
}

export interface RewardTransaction {
  id: string;
  playerId: string;
  amount: number; // +20 virtual stars per verified rewarded ad
  source: 'admob_rewarded';
  adUnitId: string;
  ssvVerified: boolean;
  createdAt: number;
}

export interface MatchHistoryEntry {
  id: string;
  roomCode: string;
  won: boolean;
  winnerName: string;
  playerCount: number;
  feroCount: number;
  score: number;
  endedAt: number;
}

export interface GameState {
  hostId: string;
  status: 'lobby' | 'playing' | 'ended';
  currentTurn: number; // slot 0..3
  diceValue: number | null;
  isRolling: boolean;
  diceRolled: boolean;
  movableTokenIds: number[];
  winnerSlot: number | null;
  runnerUpSlot?: number | null;
  targetTokensToWin: number; // 4 tokens home
  feroCount: number; // 1 to 10 rounds
  lastActionMessage: string;
  version: number;
  updatedAt: number;
}

export interface RoomState {
  code: string;
  isPrivate?: boolean;
  hostId: string;
  status: 'lobby' | 'playing' | 'ended';
  players: Player[];
  game?: GameState;
  chat?: ChatMessage[];
  currentTurn: number; // slot 0..3
  diceValue: number | null;
  isRolling: boolean;
  diceRolled: boolean;
  movableTokenIds: number[];
  winnerSlot: number | null;
  runnerUpSlot?: number | null;
  targetTokensToWin: number; // 4 tokens home
  feroCount: number; // 1 to 10 rounds
  chatMessages: ChatMessage[];
  lastActionMessage: string;
  version: number;
  updatedAt: number;
}
