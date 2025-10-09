export const MUST_WIN_BY_BID_KEY = "rookMustWinByBid";
export const TABLE_TALK_PENALTY_TYPE_KEY = "tableTalkPenaltyType";
export const TABLE_TALK_PENALTY_POINTS_KEY = "tableTalkPenaltyPoints";
export const ACTIVE_GAME_KEY = "activeGameState";
export const PRO_MODE_KEY = "proModeEnabled";
export const THEME_KEY = "rookSelectedTheme";
export const PRESET_BIDS_KEY = "customPresetBids";
export const TEAM_STORAGE_VERSION = 2;
export const TEAM_KEY_SEPARATOR = "||";

export const DEFAULT_STATE = {
  rounds: [],
  undoneRounds: [],
  biddingTeam: "",
  bidAmount: "",
  customBidValue: "",
  showCustomBid: false,
  enterBidderPoints: false,
  error: "",
  gameOver: false,
  winner: null,
  victoryMethod: null,
  savedScoreInputStates: { us: null, dem: null },
  lastBidAmount: null,
  lastBidTeam: null,
  usTeamName: "",
  demTeamName: "",
  usPlayers: ["", ""],
  demPlayers: ["", ""],
  startTime: null,
  accumulatedTime: 0,
  showWinProbability: false,
  pendingPenalty: null,
  timerLastSavedAt: null,
  startingTotals: { us: 0, dem: 0 },
};
