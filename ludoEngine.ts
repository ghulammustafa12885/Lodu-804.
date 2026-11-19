import { BoardCellCoord, Player, PlayerColor, Token } from '../types/ludo';

// 52-tile outer track coordinates in clockwise sequence starting from Green start (6, 1)
export const OUTER_TRACK_COORDS: BoardCellCoord[] = [
  { row: 6, col: 1 },  // 0: Green Start (Safe)
  { row: 6, col: 2 },  // 1
  { row: 6, col: 3 },  // 2
  { row: 6, col: 4 },  // 3
  { row: 6, col: 5 },  // 4
  { row: 5, col: 6 },  // 5
  { row: 4, col: 6 },  // 6
  { row: 3, col: 6 },  // 7
  { row: 2, col: 6 },  // 8: Safe Star
  { row: 1, col: 6 },  // 9
  { row: 0, col: 6 },  // 10
  { row: 0, col: 7 },  // 11: Yellow turn entry
  { row: 0, col: 8 },  // 12
  { row: 1, col: 8 },  // 13: Yellow Start (Safe)
  { row: 2, col: 8 },  // 14
  { row: 3, col: 8 },  // 15
  { row: 4, col: 8 },  // 16
  { row: 5, col: 8 },  // 17
  { row: 6, col: 9 },  // 18
  { row: 6, col: 10 }, // 19
  { row: 6, col: 11 }, // 20
  { row: 6, col: 12 }, // 21: Safe Star
  { row: 6, col: 13 }, // 22
  { row: 6, col: 14 }, // 23
  { row: 7, col: 14 }, // 24: Blue turn entry
  { row: 8, col: 14 }, // 25
  { row: 8, col: 13 }, // 26: Blue Start (Safe)
  { row: 8, col: 12 }, // 27
  { row: 8, col: 11 }, // 28
  { row: 8, col: 10 }, // 29
  { row: 8, col: 9 },  // 30
  { row: 9, col: 8 },  // 31
  { row: 10, col: 8 }, // 32
  { row: 11, col: 8 }, // 33
  { row: 12, col: 8 }, // 34: Safe Star
  { row: 13, col: 8 }, // 35
  { row: 14, col: 8 }, // 36
  { row: 14, col: 7 }, // 37: Red turn entry
  { row: 14, col: 6 }, // 38
  { row: 13, col: 6 }, // 39: Red Start (Safe)
  { row: 12, col: 6 }, // 40
  { row: 11, col: 6 }, // 41
  { row: 10, col: 6 }, // 42
  { row: 9, col: 6 },  // 43
  { row: 8, col: 5 },  // 44
  { row: 8, col: 4 },  // 45
  { row: 8, col: 3 },  // 46
  { row: 8, col: 2 },  // 47: Safe Star
  { row: 8, col: 1 },  // 48
  { row: 8, col: 0 },  // 49
  { row: 7, col: 0 },  // 50: Green turn entry
  { row: 6, col: 0 },  // 51
];

export const COLOR_START_INDEX: Record<PlayerColor, number> = {
  green: 0,
  yellow: 13,
  blue: 26,
  red: 39,
};

export const SAFE_TRACK_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export const HOME_STRETCH_COORDS: Record<PlayerColor, BoardCellCoord[]> = {
  green: [
    { row: 7, col: 1 },
    { row: 7, col: 2 },
    { row: 7, col: 3 },
    { row: 7, col: 4 },
    { row: 7, col: 5 },
  ],
  yellow: [
    { row: 1, col: 7 },
    { row: 2, col: 7 },
    { row: 3, col: 7 },
    { row: 4, col: 7 },
    { row: 5, col: 7 },
  ],
  blue: [
    { row: 7, col: 13 },
    { row: 7, col: 12 },
    { row: 7, col: 11 },
    { row: 7, col: 10 },
    { row: 7, col: 9 },
  ],
  red: [
    { row: 13, col: 7 },
    { row: 12, col: 7 },
    { row: 11, col: 7 },
    { row: 10, col: 7 },
    { row: 9, col: 7 },
  ],
};

export const HOME_CENTER_COORDS: Record<PlayerColor, BoardCellCoord> = {
  green: { row: 7, col: 6.2 },
  yellow: { row: 6.2, col: 7 },
  blue: { row: 7, col: 7.8 },
  red: { row: 7.8, col: 7 },
};

export const YARD_COORDS: Record<PlayerColor, BoardCellCoord[]> = {
  green: [
    { row: 1.5, col: 1.5 },
    { row: 1.5, col: 3.5 },
    { row: 3.5, col: 1.5 },
    { row: 3.5, col: 3.5 },
  ],
  yellow: [
    { row: 1.5, col: 10.5 },
    { row: 1.5, col: 12.5 },
    { row: 3.5, col: 10.5 },
    { row: 3.5, col: 12.5 },
  ],
  blue: [
    { row: 10.5, col: 10.5 },
    { row: 10.5, col: 12.5 },
    { row: 12.5, col: 10.5 },
    { row: 12.5, col: 12.5 },
  ],
  red: [
    { row: 10.5, col: 1.5 },
    { row: 10.5, col: 3.5 },
    { row: 12.5, col: 1.5 },
    { row: 12.5, col: 3.5 },
  ],
};

export function getTokenBoardCoord(color: PlayerColor, tokenId: number, step: number): BoardCellCoord {
  if (step === -1) {
    return YARD_COORDS[color][tokenId];
  }
  if (step >= 0 && step <= 50) {
    const startIdx = COLOR_START_INDEX[color];
    const trackIdx = (startIdx + step) % 52;
    return OUTER_TRACK_COORDS[trackIdx];
  }
  if (step >= 51 && step <= 55) {
    const stretchIdx = step - 51;
    return HOME_STRETCH_COORDS[color][stretchIdx];
  }
  return HOME_CENTER_COORDS[color];
}

export function getTrackIndex(color: PlayerColor, step: number): number | null {
  if (step >= 0 && step <= 50) {
    const startIdx = COLOR_START_INDEX[color];
    return (startIdx + step) % 52;
  }
  return null;
}

export function isValidTokenMove(token: Token, dice: number): boolean {
  if (dice < 1 || dice > 6) return false;
  if (token.step === 56) return false;
  if (token.step === -1) {
    return dice === 6;
  }
  return token.step + dice <= 56;
}

export function getMovableTokens(player: Player, dice: number): number[] {
  return player.tokens.filter((t) => isValidTokenMove(t, dice)).map((t) => t.id);
}

/**
 * Finds all opponent tokens occupying the destination non-safe square so multi-token captures
 * match authoritative server behavior cleanly.
 */
export function checkAllTokenCuttings(
  attackerColor: PlayerColor,
  targetStep: number,
  allPlayers: Player[]
): { playerSlot: number; tokenId: number; playerName: string }[] {
  const targetTrackIdx = getTrackIndex(attackerColor, targetStep);
  if (targetTrackIdx === null) return [];
  if (SAFE_TRACK_INDICES.has(targetTrackIdx)) return [];

  const cuts: { playerSlot: number; tokenId: number; playerName: string }[] = [];
  for (const opp of allPlayers) {
    if (opp.color === attackerColor) continue;
    for (const oppToken of opp.tokens) {
      const oppTrackIdx = getTrackIndex(opp.color, oppToken.step);
      if (oppTrackIdx === targetTrackIdx) {
        cuts.push({
          playerSlot: opp.slot,
          tokenId: oppToken.id,
          playerName: opp.name,
        });
      }
    }
  }
  return cuts;
}

export function checkTokenCutting(
  attackerColor: PlayerColor,
  targetStep: number,
  allPlayers: Player[]
): { playerSlot: number; tokenId: number } | null {
  const cuts = checkAllTokenCuttings(attackerColor, targetStep, allPlayers);
  return cuts.length > 0 ? { playerSlot: cuts[0].playerSlot, tokenId: cuts[0].tokenId } : null;
}

export function calculatePlayerScore(player: Player): number {
  return (
    player.tokensHome * 100 +
    player.tokens.reduce((acc, t) => acc + (t.step > 0 ? t.step : 0), 0)
  );
}

export function chooseBestBotMove(player: Player, dice: number, allPlayers: Player[]): number {
  const movable = getMovableTokens(player, dice);
  if (movable.length === 0) return -1;
  if (movable.length === 1) return movable[0];

  for (const tid of movable) {
    const t = player.tokens.find((item) => item.id === tid)!;
    const targetStep = t.step === -1 ? 0 : t.step + dice;
    if (checkAllTokenCuttings(player.color, targetStep, allPlayers).length > 0) return tid;
  }

  for (const tid of movable) {
    const t = player.tokens.find((item) => item.id === tid)!;
    if (t.step + dice === 56) return tid;
  }

  if (dice === 6) {
    const yardToken = movable.find((tid) => {
      const t = player.tokens.find((item) => item.id === tid)!;
      return t.step === -1;
    });
    if (yardToken !== undefined) return yardToken;
  }

  let bestToken = movable[0];
  let maxStep = -1;
  for (const tid of movable) {
    const t = player.tokens.find((item) => item.id === tid)!;
    if (t.step > maxStep) {
      maxStep = t.step;
      bestToken = tid;
    }
  }

  return bestToken;
}
