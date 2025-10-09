import { TEAM_KEY_SEPARATOR } from "./constants.js";

export function sanitizeTotals(input) {
  if (!input || typeof input !== "object") return { us: 0, dem: 0 };
  const parse = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  };
  return { us: parse(input.us), dem: parse(input.dem) };
}

export function sanitizePlayerName(name) {
  return (typeof name === "string" ? name : "").trim().replace(/\s+/g, " ");
}

export function ensurePlayersArray(input) {
  const arr = Array.isArray(input) ? input : [];
  const first = arr.length > 0 && arr[0] != null ? arr[0] : "";
  const second = arr.length > 1 && arr[1] != null ? arr[1] : "";
  return [sanitizePlayerName(first), sanitizePlayerName(second)];
}

export function canonicalizePlayers(players) {
  const arr = ensurePlayersArray(players);
  const nonEmpty = arr.filter(Boolean);
  if (!nonEmpty.length) return arr;
  const sorted = [...nonEmpty].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  return [sorted[0] || "", sorted[1] || ""];
}

export function formatTeamDisplay(players) {
  const cleaned = ensurePlayersArray(players).filter(Boolean);
  return cleaned.join(" & ");
}

export function buildTeamKey(players) {
  const cleaned = ensurePlayersArray(players)
    .filter(Boolean)
    .map((name) => name.toLowerCase());
  return cleaned.sort().join(TEAM_KEY_SEPARATOR);
}

export function parseLegacyTeamName(teamName) {
  const raw = sanitizePlayerName(teamName);
  if (!raw) return ["", ""];
  const separators = [
    /\s*&\s*/i,
    /\s+and\s+/i,
    /\s*\+\s*/i,
    /\s*\/\s*/,
    /\s*,\s*/,
  ];
  for (const sep of separators) {
    if (sep.test(raw)) {
      const parts = raw
        .split(sep)
        .map(sanitizePlayerName)
        .filter(Boolean);
      if (parts.length >= 2) return [parts[0], parts[1]];
    }
  }
  return [raw, ""];
}

export function deriveTeamDisplay(players, fallback = "") {
  const display = formatTeamDisplay(players);
  return display || fallback;
}

export function getGameTeamDisplay(game, side) {
  const fallback = side === "us" ? "Us" : "Dem";
  if (!game || (side !== "us" && side !== "dem")) return fallback;
  const playersField =
    side === "us"
      ? game.usPlayers || game.usTeamPlayers || game.usTeam
      : game.demPlayers || game.demTeamPlayers || game.demTeam;
  const canonicalPlayers = canonicalizePlayers(playersField);
  const nameField =
    side === "us"
      ? game.usTeamName || game.usName
      : game.demTeamName || game.demName;
  return deriveTeamDisplay(canonicalPlayers, nameField || fallback) || fallback;
}

export function playersEqual(a, b) {
  const [a1, a2] = canonicalizePlayers(a);
  const [b1, b2] = canonicalizePlayers(b);
  return a1 === b1 && a2 === b2;
}
