import {
  ACTIVE_GAME_KEY,
  DEFAULT_STATE,
  PRO_MODE_KEY,
} from "./constants.js";
import {
  sanitizeTotals,
  ensurePlayersArray,
  deriveTeamDisplay,
  parseLegacyTeamName,
} from "./utils.js";
import { setLocalStorage } from "./storage.js";

export const MAX_GAME_TIME_MS = 10 * 60 * 60 * 1000; // 10 hours maximum
export const MAX_ROUND_TIME_MS = 2 * 60 * 60 * 1000; // 2 hours maximum per round

const createInitialState = () => ({
  ...DEFAULT_STATE,
  rounds: [],
  undoneRounds: [],
  savedScoreInputStates: { ...DEFAULT_STATE.savedScoreInputStates },
  usPlayers: [...DEFAULT_STATE.usPlayers],
  demPlayers: [...DEFAULT_STATE.demPlayers],
  startingTotals: { ...DEFAULT_STATE.startingTotals },
});

export const state = createInitialState();

const hasOwn = (obj, key) =>
  Object.prototype.hasOwnProperty.call(obj, key);

function applyPlayerFields(nextState, teamKey) {
  const playersKey = `${teamKey}Players`;
  const teamNameKey = `${teamKey}TeamName`;

  if (hasOwn(nextState, playersKey)) {
    const players = ensurePlayersArray(nextState[playersKey]);
    nextState[playersKey] = players;
    if (!hasOwn(nextState, teamNameKey)) {
      nextState[teamNameKey] = deriveTeamDisplay(players);
    }
  } else if (hasOwn(nextState, teamNameKey)) {
    const parsed = parseLegacyTeamName(nextState[teamNameKey]);
    const players = ensurePlayersArray(parsed);
    nextState[playersKey] = players;
    nextState[teamNameKey] = deriveTeamDisplay(
      players,
      nextState[teamNameKey]
    );
  }
}

function sanitizePatch(partial) {
  if (!partial || typeof partial !== "object") return {};
  const nextState = { ...partial };

  applyPlayerFields(nextState, "us");
  applyPlayerFields(nextState, "dem");

  if (hasOwn(nextState, "startingTotals")) {
    nextState.startingTotals = sanitizeTotals(nextState.startingTotals);
  }

  return nextState;
}

function replaceState(nextState) {
  const clean = sanitizePatch(nextState);
  const base = createInitialState();
  Object.assign(base, clean);

  Object.keys(state).forEach((key) => {
    delete state[key];
  });
  Object.assign(state, base);
  return state;
}

export function mergeState(partial) {
  const sanitized = sanitizePatch(partial);
  Object.assign(state, sanitized);
  return state;
}

export function resetState({ showWinProbability = false } = {}) {
  return replaceState({
    ...createInitialState(),
    showWinProbability,
    pendingPenalty: null,
  });
}

export function loadState() {
  let loadedState = null;
  try {
    const stored = localStorage.getItem(ACTIVE_GAME_KEY);
    if (stored) {
      loadedState = JSON.parse(stored);
    }
  } catch (error) {
    console.error(
      "Error parsing activeGameState from localStorage. Resetting to default.",
      error
    );
    localStorage.removeItem(ACTIVE_GAME_KEY);
  }

  if (loadedState && typeof loadedState === "object") {
    const base = createInitialState();
    const complete = { ...base, ...loadedState };
    complete.rounds = Array.isArray(loadedState.rounds)
      ? loadedState.rounds
      : [];
    complete.undoneRounds = Array.isArray(loadedState.undoneRounds)
      ? loadedState.undoneRounds
      : [];

    const now = Date.now();
    const hasRounds =
      Array.isArray(complete.rounds) && complete.rounds.length > 0;
    const timerWasRunning =
      typeof complete.startTime === "number" &&
      !complete.gameOver &&
      hasRounds;
    const storedAccumulated = Number(complete.accumulatedTime);
    const sanitizedAccumulated =
      Number.isFinite(storedAccumulated) && storedAccumulated >= 0
        ? storedAccumulated
        : 0;

    if (timerWasRunning) {
      if (typeof complete.timerLastSavedAt !== "number") {
        complete.accumulatedTime = calculateSafeTimeAccumulation(
          sanitizedAccumulated,
          complete.startTime
        );
      } else {
        complete.accumulatedTime = Math.min(
          sanitizedAccumulated,
          MAX_GAME_TIME_MS
        );
      }
      complete.startTime = now;
    } else {
      complete.accumulatedTime = Math.min(
        sanitizedAccumulated,
        MAX_GAME_TIME_MS
      );
      complete.startTime = null;
    }

    complete.timerLastSavedAt = now;
    try {
      complete.showWinProbability = JSON.parse(
        localStorage.getItem(PRO_MODE_KEY) || "false"
      );
    } catch (error) {
      console.warn("Unable to parse PRO_MODE_KEY:", error);
      complete.showWinProbability = false;
    }
    complete.startingTotals = sanitizeTotals(complete.startingTotals);
    replaceState(complete);
    return state;
  }

  if (loadedState) {
    localStorage.removeItem(ACTIVE_GAME_KEY);
  }
  const proModeEnabled = JSON.parse(
    localStorage.getItem(PRO_MODE_KEY) || "false"
  );
  resetState({ showWinProbability: proModeEnabled });
  return state;
}

export function saveState() {
  if (state.gameOver) {
    localStorage.removeItem(ACTIVE_GAME_KEY);
    if (
      window.syncToFirestore &&
      window.firebaseReady &&
      window.firebaseAuth &&
      window.firebaseAuth.currentUser
    ) {
      window.syncToFirestore(ACTIVE_GAME_KEY, null);
    }
    return false;
  }

  const timerRunning = state.startTime !== null;
  const now = Date.now();
  const finalAccumulated = timerRunning
    ? calculateSafeTimeAccumulation(state.accumulatedTime, state.startTime)
    : Math.min(Number(state.accumulatedTime) || 0, MAX_GAME_TIME_MS);

  const snapshot = {
    ...state,
    accumulatedTime: finalAccumulated,
    startTime: timerRunning ? now : null,
    timerLastSavedAt: now,
    startingTotals: sanitizeTotals(state.startingTotals),
  };

  state.timerLastSavedAt = now;
  setLocalStorage(ACTIVE_GAME_KEY, snapshot);
  return true;
}

export function getBaseTotals() {
  return sanitizeTotals(state.startingTotals);
}

export function getCurrentTotals() {
  const base = getBaseTotals();
  return state.rounds.reduce(
    (acc, round) => {
      const usPoints = Number(round.usPoints);
      const demPoints = Number(round.demPoints);
      return {
        us: acc.us + (Number.isFinite(usPoints) ? usPoints : 0),
        dem: acc.dem + (Number.isFinite(demPoints) ? demPoints : 0),
      };
    },
    { ...base }
  );
}

export function getLastRunningTotals() {
  if (state.rounds.length) {
    const last = state.rounds[state.rounds.length - 1].runningTotals;
    return sanitizeTotals(last);
  }
  return getBaseTotals();
}

export function calculateSafeTimeAccumulation(
  currentAccumulated,
  startTime
) {
  if (!startTime) return currentAccumulated;

  const elapsed = Date.now() - startTime;
  const cappedElapsed = Math.min(elapsed, MAX_ROUND_TIME_MS);
  const totalTime = currentAccumulated + cappedElapsed;
  return Math.min(totalTime, MAX_GAME_TIME_MS);
}

export function getCurrentGameTime() {
  if (!state.startTime) return state.accumulatedTime;
  const elapsed = Date.now() - state.startTime;
  return state.accumulatedTime + elapsed;
}
