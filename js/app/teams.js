import { TEAM_STORAGE_VERSION } from "./constants.js";
import {
  canonicalizePlayers,
  ensurePlayersArray,
  deriveTeamDisplay,
  buildTeamKey,
  parseLegacyTeamName,
} from "./utils.js";
import { getLocalStorage, setLocalStorage } from "./storage.js";
import { state } from "./state.js";

export function normalizeTeamsStorage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { data: {}, changed: Boolean(raw && raw !== null) };
  }

  const working = { ...raw };
  delete working.__storageVersion;

  const entries = Object.entries(working);
  if (!entries.length) {
    return { data: {}, changed: raw.__storageVersion !== TEAM_STORAGE_VERSION };
  }

  const isAlreadyNew = entries.every(
    ([, value]) =>
      value &&
      typeof value === "object" &&
      Array.isArray(value.players)
  );

  if (raw.__storageVersion === TEAM_STORAGE_VERSION && isAlreadyNew) {
    const cleaned = {};
    entries.forEach(([key, value]) => {
      cleaned[key] = {
        players: ensurePlayersArray(value.players),
        displayName: deriveTeamDisplay(
          value.players,
          value.displayName || ""
        ),
        wins: Number(value.wins) || 0,
        losses: Number(value.losses) || 0,
        gamesPlayed: Number(value.gamesPlayed) || 0,
      };
    });
    return { data: cleaned, changed: false };
  }

  const converted = {};
  entries.forEach(([legacyName, payload]) => {
    let players = [];
    let stats = { wins: 0, losses: 0, gamesPlayed: 0 };

    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Array.isArray(payload.players)
    ) {
      players = canonicalizePlayers(payload.players);
      stats = {
        wins: Number(payload.wins) || 0,
        losses: Number(payload.losses) || 0,
        gamesPlayed: Number(payload.gamesPlayed) || 0,
      };
    } else {
      players = canonicalizePlayers(parseLegacyTeamName(legacyName));
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        stats = {
          wins: Number(payload.wins) || 0,
          losses: Number(payload.losses) || 0,
          gamesPlayed: Number(payload.gamesPlayed) || 0,
        };
      }
    }

    const key = buildTeamKey(players);
    const displayName = deriveTeamDisplay(players, legacyName);
    if (!converted[key]) {
      converted[key] = {
        players: canonicalizePlayers(players),
        displayName,
        wins: 0,
        losses: 0,
        gamesPlayed: 0,
      };
    }
    converted[key].wins += stats.wins;
    converted[key].losses += stats.losses;
    converted[key].gamesPlayed += stats.gamesPlayed;
    if (!converted[key].displayName) {
      converted[key].displayName = displayName;
    }
  });

  return { data: converted, changed: true };
}

export function getTeamsObject() {
  const raw = getLocalStorage("teams") || {};
  const { data, changed } = normalizeTeamsStorage(raw);
  if (changed) setTeamsObject(data);
  return data;
}

export function setTeamsObject(obj) {
  const entries = {};
  Object.entries(obj || {}).forEach(([key, value]) => {
    if (!key || !value) return;
    entries[key] = {
      players: canonicalizePlayers(value.players),
      displayName: deriveTeamDisplay(
        canonicalizePlayers(value.players),
        value.displayName || ""
      ),
      wins: Number(value.wins) || 0,
      losses: Number(value.losses) || 0,
      gamesPlayed: Number(value.gamesPlayed) || 0,
    };
  });
  setLocalStorage("teams", { __storageVersion: TEAM_STORAGE_VERSION, ...entries });
}

export function ensureTeamEntry(
  teamsObj,
  players,
  fallbackDisplay = ""
) {
  const normalizedPlayers = canonicalizePlayers(players);
  const key = buildTeamKey(normalizedPlayers);
  if (!key) return { teams: teamsObj, key: null };
  if (!teamsObj[key]) {
    teamsObj[key] = {
      players: normalizedPlayers,
      displayName: deriveTeamDisplay(
        normalizedPlayers,
        fallbackDisplay || "Unnamed Team"
      ),
      wins: 0,
      losses: 0,
      gamesPlayed: 0,
    };
  } else {
    teamsObj[key].players = ensurePlayersArray(teamsObj[key].players);
    if (!teamsObj[key].displayName) {
      teamsObj[key].displayName = deriveTeamDisplay(
        normalizedPlayers,
        fallbackDisplay || "Unnamed Team"
      );
    }
  }
  return { teams: teamsObj, key };
}

export function applyTeamResultDelta(
  teamsObj,
  { usPlayers, demPlayers, usDisplay, demDisplay, winner },
  direction = 1
) {
  if (!direction) return false;

  const normalizedUs = canonicalizePlayers(usPlayers);
  const normalizedDem = canonicalizePlayers(demPlayers);
  const usName =
    deriveTeamDisplay(normalizedUs, usDisplay || "Us") || "Us";
  const demName =
    deriveTeamDisplay(normalizedDem, demDisplay || "Dem") || "Dem";
  const usKey = buildTeamKey(normalizedUs);
  const demKey = buildTeamKey(normalizedDem);
  if (!usKey || !demKey) return false;

  if (direction > 0) {
    ensureTeamEntry(teamsObj, normalizedUs, usName);
    ensureTeamEntry(teamsObj, normalizedDem, demName);
  }

  const usEntry = teamsObj[usKey];
  const demEntry = teamsObj[demKey];
  if (!usEntry || !demEntry) return false;

  const clamp = (value) => Math.max(0, Number.isFinite(value) ? value : 0);

  usEntry.players = canonicalizePlayers(usEntry.players);
  demEntry.players = canonicalizePlayers(demEntry.players);
  if (!usEntry.displayName) usEntry.displayName = usName;
  if (!demEntry.displayName) demEntry.displayName = demName;

  usEntry.gamesPlayed = clamp((Number(usEntry.gamesPlayed) || 0) + direction);
  demEntry.gamesPlayed = clamp((Number(demEntry.gamesPlayed) || 0) + direction);

  if (winner === "us") {
    usEntry.wins = clamp((Number(usEntry.wins) || 0) + direction);
    demEntry.losses = clamp((Number(demEntry.losses) || 0) + direction);
  } else if (winner === "dem") {
    demEntry.wins = clamp((Number(demEntry.wins) || 0) + direction);
    usEntry.losses = clamp((Number(usEntry.losses) || 0) + direction);
  }

  return true;
}

export function updateTeamsStatsOnGameEnd(winner) {
  const teams = getTeamsObject();
  const updated = applyTeamResultDelta(
    teams,
    {
      usPlayers: state.usPlayers,
      demPlayers: state.demPlayers,
      usDisplay: state.usTeamName,
      demDisplay: state.demTeamName,
      winner,
    },
    1
  );
  if (updated) setTeamsObject(teams);
}

export function recalcTeamsStats() {
  const teams = getTeamsObject();
  Object.values(teams).forEach((entry) => {
    if (!entry) return;
    entry.gamesPlayed = 0;
    entry.wins = 0;
    entry.losses = 0;
  });

  const accumulateFromGame = (game) => {
    if (!game) return;
    const usPlayers = canonicalizePlayers(
      game.usPlayers || parseLegacyTeamName(game.usTeamName || game.usName)
    );
    const demPlayers = canonicalizePlayers(
      game.demPlayers || parseLegacyTeamName(game.demTeamName || game.demName)
    );
    const usDisplay = deriveTeamDisplay(
      usPlayers,
      game.usTeamName || game.usName || "Us"
    );
    const demDisplay = deriveTeamDisplay(
      demPlayers,
      game.demTeamName || game.demName || "Dem"
    );
    const winner =
      game.winner === "us" || game.winner === "dem" ? game.winner : null;
    applyTeamResultDelta(
      teams,
      { usPlayers, demPlayers, usDisplay, demDisplay, winner },
      1
    );
  };

  const savedGames = getLocalStorage("savedGames", []);
  savedGames.forEach(accumulateFromGame);

  if (state.gameOver && Array.isArray(state.rounds) && state.rounds.length) {
    accumulateFromGame({
      usPlayers: ensurePlayersArray(state.usPlayers),
      demPlayers: ensurePlayersArray(state.demPlayers),
      usTeamName: state.usTeamName,
      demTeamName: state.demTeamName,
      winner: state.winner,
    });
  }

  setTeamsObject(teams);
}

export function addTeamIfNotExists(players, display = "") {
  const teams = getTeamsObject();
  const { key } = ensureTeamEntry(teams, players, display);
  if (key) setTeamsObject(teams);
}
