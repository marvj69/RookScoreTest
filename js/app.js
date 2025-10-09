import {
  MUST_WIN_BY_BID_KEY,
  TABLE_TALK_PENALTY_TYPE_KEY,
  TABLE_TALK_PENALTY_POINTS_KEY,
  ACTIVE_GAME_KEY,
  PRO_MODE_KEY,
  PRESET_BIDS_KEY,
  TEAM_STORAGE_VERSION,
} from "./app/constants.js";
import {
  sanitizeTotals,
  sanitizePlayerName,
  ensurePlayersArray,
  canonicalizePlayers,
  formatTeamDisplay,
  buildTeamKey,
  parseLegacyTeamName,
  deriveTeamDisplay,
  getGameTeamDisplay,
  playersEqual,
} from "./app/utils.js";
import {
  calculateWinProbability,
  renderProbabilityBreakdown,
} from "./app/probability.js";
import { setLocalStorage, getLocalStorage } from "./app/storage.js";
import {
  state,
  mergeState,
  resetState,
  loadState,
  saveState,
  getBaseTotals,
  getCurrentTotals,
  getLastRunningTotals,
  calculateSafeTimeAccumulation,
  getCurrentGameTime,
  MAX_GAME_TIME_MS,
  MAX_ROUND_TIME_MS,
} from "./app/state.js";
import {
  enforceDarkMode,
  initializeTheme,
  initializeCustomThemeColors,
  applyCustomThemeColors,
  resetThemeColors,
  randomizeThemeColors,
  updatePreview,
  openThemeModal,
  closeThemeModal,
} from "./app/theme.js";
import {
  normalizeTeamsStorage,
  getTeamsObject,
  setTeamsObject,
  ensureTeamEntry,
  applyTeamResultDelta,
  updateTeamsStatsOnGameEnd,
  recalcTeamsStats,
  addTeamIfNotExists,
} from "./app/teams.js";

// --- Global State ---
let confettiTriggered = false;
let ephemeralCustomBid = ""; // For temporarily holding input value before state update
let ephemeralPoints = "";    // Same for points
let confirmationCallback = null;
let noCallback = null;
let pendingGameAction = null; // For actions requiring team name input first
let statsViewMode = 'teams';
let statsMetricKey = 'games';

let presetBids;
  try {
    const raw = localStorage.getItem(PRESET_BIDS_KEY);
    const parsed = JSON.parse(raw);
    presetBids   = Array.isArray(parsed) && parsed.length ? parsed : null;
   } catch (_) { presetBids = null; }
  if (!presetBids) presetBids = [120,125,130,135,140,145,"other"]; 

let scoreCardHasAnimated  = false;
let historyCardHasAnimated = false;

// --- Win-probability engine -------------------------------------------

// --- Icons ---
const Icons = { // SVG strings for icons to avoid multiple DOM elements
  AlertCircle: '<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4m0 4h.01"></path></svg>',
  Undo: '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v6h6M21 17a9 9 0 0 0-9-9c-2.5 0-4.75.9-6.5 2.4L3 11"/></svg>',
  Redo: '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 7v6h-6M3 17a9 9 0 0 1 9-9c2.5 0 4.75.9 6.5 2.4L21 11"/></svg>',
  Trash: '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
  Load: '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>',
  Trophy: '<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 inline-block mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M7 10V4h10v6M7 10l-1 12h12 l-1-12M7 10h10m-5 12v-6"/></svg>',
};

// --- Bid Preset Logic ---
function savePresetBids() { setLocalStorage(PRESET_BIDS_KEY, presetBids); }
function openPresetEditorModal() {
  // No longer restrict to Pro Mode
  const settingsModal = document.getElementById("settingsModal");
  if (settingsModal) {
    settingsModal.classList.add("hidden");
  }

  const existingModal = document.getElementById("presetEditorModal");
  if (existingModal) existingModal.remove();

  const modalHtml = `
      <div id="presetEditorModal" class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 modal" role="dialog" aria-modal="true" aria-labelledby="presetEditorTitle">
          <div class="bg-white w-full max-w-md rounded-xl shadow-lg dark:bg-gray-800 p-6 transform transition-all">
              <div class="flex items-center justify-between mb-4">
                  <h2 id="presetEditorTitle" class="text-2xl font-bold text-gray-800 dark:text-white">Edit Bid Presets</h2>
                  <button type="button" onclick="closePresetEditorModal()" class="text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-full p-1">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
              </div>
              <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">Customize quick bid buttons. Values must be multiples of 5.</p>
              <div id="presetInputs" class="space-y-3 max-h-64 overflow-y-auto pr-2 mb-4">
                  ${presetBids.filter(b => b !== "other").map((bid, index) => `
                      <div class="flex items-center space-x-3 preset-input-row">
                          <div class="flex-grow relative">
                              <input type="number" value="${bid}" min="5" max="360" step="5" class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white" data-index="${index}" onchange="validatePresetInput(this)">
                              <div class="preset-error text-xs text-red-500 mt-1 hidden"></div>
                          </div>
                          <button type="button" onclick="removePreset(${index})" class="bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-red-600 hover:text-red-700 dark:text-red-400 p-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors">${Icons.Trash}</button>
                      </div>`).join('')}
              </div>
              <div class="flex gap-2 flex-wrap mb-6">
                  <button type="button" onclick="addPreset()" class="flex items-center bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-800/40 text-blue-600 dark:text-blue-400 px-4 py-2 rounded-lg font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors threed"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>Add Preset</button>
              </div>
              <div id="presetErrorMsg" class="text-red-500 text-sm mb-4 hidden"></div>
              <div class="flex justify-end gap-3">
                  <button type="button" onclick="closePresetEditorModal()" class="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-400 transition-colors threed">Cancel</button>
                  <button type="button" onclick="savePresets()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors threed">Save Changes</button>
              </div>
          </div>
      </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  const modalEl = document.getElementById("presetEditorModal");
  if (modalEl) {
    modalEl.addEventListener("click", (event) => {
      if (event.target === modalEl) closePresetEditorModal();
    });
    const content = modalEl.querySelector(".bg-white, .dark\\:bg-gray-800");
    if (content) content.addEventListener("click", (event) => event.stopPropagation());
  }
  activateModalEnvironment();
}
function closePresetEditorModal() {
  const modal = document.getElementById('presetEditorModal');
  if (modal) {
    modal.remove();
  }
  const settingsModal = document.getElementById("settingsModal");
  if (settingsModal) {
    settingsModal.classList.remove("hidden");
  }
  deactivateModalEnvironment();
}

function validatePresetInput(inputEl) {
  const val = Number(inputEl.value);
  const errDiv = inputEl.nextElementSibling;
  let msg = "";
  if (isNaN(val)) msg = "Must be a number.";
  else if (val <= 0) msg = "Must be > 0.";
  else if (val % 5 !== 0) msg = "Must be div by 5.";
  else if (val > 360) msg = "Cannot exceed 360.";
  errDiv.textContent = msg;
  errDiv.classList.toggle("hidden", !msg);
  return !msg;
}
function addPreset() {
  const container = document.getElementById('presetInputs');
  const newIdx = container.querySelectorAll('.preset-input-row').length;
  container.insertAdjacentHTML('beforeend', `
      <div class="flex items-center space-x-3 preset-input-row animate-fadeIn">
          <div class="flex-grow relative">
              <input type="number" value="120" min="5" max="360" step="5" class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white" data-index="${newIdx}" onchange="validatePresetInput(this)">
              <div class="preset-error text-xs text-red-500 mt-1 hidden"></div>
          </div>
          <button type="button" onclick="removePreset(${newIdx})" class="bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-red-600 hover:text-red-700 dark:text-red-400 p-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors">${Icons.Trash}</button>
      </div>`);
  container.scrollTop = container.scrollHeight;
}
function removePreset(index) {
  const rows = document.querySelectorAll('#presetInputs .preset-input-row');
  const errorMsgEl = document.getElementById('presetErrorMsg');
  if (rows.length <= 1) {
      errorMsgEl.textContent = 'Must have at least one preset.';
      errorMsgEl.classList.remove('hidden');
      setTimeout(() => errorMsgEl.classList.add('hidden'), 3000);
      return;
  }
  const rowToRemove = Array.from(rows).find(r => {
      const input = r.querySelector('input[data-index]');
      return input && input.dataset.index == index;
  });
  if (rowToRemove) {
      rowToRemove.classList.add('animate-fadeOut');
      setTimeout(() => {
          rowToRemove.remove();
          // Re-index remaining rows
          document.querySelectorAll('#presetInputs .preset-input-row').forEach((r, i) => {
              r.querySelector('input').dataset.index = i;
              r.querySelector('button').setAttribute('onclick', `removePreset(${i})`);
          });
      }, 150);
  }
}
function savePresets() {
  const inputs = Array.from(document.querySelectorAll('#presetInputs input'));
  const errorMsgEl = document.getElementById('presetErrorMsg');
  if (inputs.some(input => !validatePresetInput(input))) {
      errorMsgEl.textContent = 'Fix errors before saving.';
      errorMsgEl.classList.remove('hidden');
      return;
  }
  const newPresetsNum = inputs.map(input => Number(input.value));
  if (new Set(newPresetsNum).size !== newPresetsNum.length) {
      errorMsgEl.textContent = 'Duplicate values not allowed.';
      errorMsgEl.classList.remove('hidden');
      return;
  }
  if (newPresetsNum.length === 0) {
      errorMsgEl.textContent = 'At least one preset required.';
      errorMsgEl.classList.remove('hidden');
      return;
  }
  presetBids = [...newPresetsNum.sort((a, b) => a - b), "other"];
  savePresetBids();
  closePresetEditorModal();
  renderApp();
  showSaveIndicator("Bid presets updated");
}

// --- Theme & UI Helpers ---
function showSaveIndicator(message = "Saved") {
  const el = document.getElementById("saveIndicator");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden", "bg-red-600"); // Remove error class if present
  el.classList.add("show");
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.classList.add("hidden"), 150); }, 1000);
}

// --- Game State Management ---
function updateState(newState) {
  mergeState(newState);
  renderApp();
}

function resetGame() {
  const isProMode = JSON.parse(localStorage.getItem(PRO_MODE_KEY) || "false");
  resetState({ showWinProbability: isProMode });
  confettiTriggered = false;
  ephemeralCustomBid = "";
  ephemeralPoints = "";
  localStorage.removeItem(ACTIVE_GAME_KEY);
  if (
    window.syncToFirestore &&
    window.firebaseReady &&
    window.firebaseAuth &&
    window.firebaseAuth.currentUser
  ) {
    window.syncToFirestore(ACTIVE_GAME_KEY, null);
  }
  renderApp();
}

function loadCurrentGameState() {
  loadState();
  renderApp();
}

function saveCurrentGameState() {
  if (saveState()) {
    showSaveIndicator();
  }
}

// --- Team Stats Helpers ---
// --- Menu & Modal Toggling ---
function toggleMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById("menu");
  const icon = document.getElementById("hamburgerIcon");
  const overlay = document.getElementById("menuOverlay");
  const isOpen = menu.classList.toggle("show");
  icon.classList.toggle("open", isOpen);
  overlay.classList.toggle("show", isOpen);
  document.body.classList.toggle("overflow-hidden", isOpen);
}
function closeMenuOverlay() { toggleMenu(null); } // Simplified close

function activateModalEnvironment() {
  document.body.classList.add("modal-open");
  const appEl = document.getElementById("app");
  if (appEl) {
    appEl.classList.add("modal-active");
  }
}

function deactivateModalEnvironment() {
  const anyOpenModal = Array.from(document.querySelectorAll(".modal"))
    .some(modal => !modal.classList.contains("hidden"));
  if (!anyOpenModal) {
    document.body.classList.remove("modal-open");
    const appEl = document.getElementById("app");
    if (appEl) {
      appEl.classList.remove("modal-active");
    }
  }
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove("hidden");
    modal.focus();
  }
  activateModalEnvironment();
}
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add("hidden");
  }
  deactivateModalEnvironment();
}
function openSavedGamesModal() {
  updateGamesCount();
  switchGamesTab('completed'); // Default to completed games
  renderGamesWithFilter(); // Render based on default filter/sort
  openModal("savedGamesModal");
}
function closeSavedGamesModal() { closeModal("savedGamesModal"); }
function openConfirmationModal(message, yesCb, noCb) {
  document.getElementById("confirmationModalMessage").textContent = message;
  confirmationCallback = yesCb; noCallback = noCb;
  openModal("confirmationModal");
  // Re-bind buttons to avoid multiple listeners if not careful
  const yesBtn = document.getElementById("confirmModalButton");
  const noBtn = document.getElementById("noModalButton");
  const newYes = yesBtn.cloneNode(true); yesBtn.parentNode.replaceChild(newYes, yesBtn);
  const newNo = noBtn.cloneNode(true); noBtn.parentNode.replaceChild(newNo, noBtn);
  newYes.addEventListener("click", (e) => { e.stopPropagation(); if (confirmationCallback) confirmationCallback(); });
  newNo.addEventListener("click", (e) => { e.stopPropagation(); if (noCallback) noCallback(); });
}
function closeConfirmationModal() { closeModal("confirmationModal"); confirmationCallback = null; noCallback = null; }
function openTeamSelectionModal() { populateTeamSelects(); openModal("teamSelectionModal"); }
function closeTeamSelectionModal() { closeModal("teamSelectionModal"); }
function openResumeGameModal() {
  const form = document.getElementById("resumeGameForm");
  const errorEl = document.getElementById("resumeGameError");
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }
  if (form) form.reset();

  const totals = getCurrentTotals();
  const basePlayers = {
    us: (() => {
      const players = ensurePlayersArray(state.usPlayers);
      if (players.some(Boolean)) return players;
      return ensurePlayersArray(parseLegacyTeamName(state.usTeamName || ""));
    })(),
    dem: (() => {
      const players = ensurePlayersArray(state.demPlayers);
      if (players.some(Boolean)) return players;
      return ensurePlayersArray(parseLegacyTeamName(state.demTeamName || ""));
    })(),
  };

  const usPlayerOneInput = document.getElementById("resumeUsPlayerOne");
  const usPlayerTwoInput = document.getElementById("resumeUsPlayerTwo");
  const demPlayerOneInput = document.getElementById("resumeDemPlayerOne");
  const demPlayerTwoInput = document.getElementById("resumeDemPlayerTwo");
  const usScoreInput = document.getElementById("resumeUsScore");
  const demScoreInput = document.getElementById("resumeDemScore");

  if (usPlayerOneInput) usPlayerOneInput.value = basePlayers.us[0] || "";
  if (usPlayerTwoInput) usPlayerTwoInput.value = basePlayers.us[1] || "";
  if (demPlayerOneInput) demPlayerOneInput.value = basePlayers.dem[0] || "";
  if (demPlayerTwoInput) demPlayerTwoInput.value = basePlayers.dem[1] || "";
  if (usScoreInput) usScoreInput.value = totals.us;
  if (demScoreInput) demScoreInput.value = totals.dem;

  openModal("resumeGameModal");
}
function closeResumeGameModal() {
  const errorEl = document.getElementById("resumeGameError");
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }
  closeModal("resumeGameModal");
}
function handleResumeGameSubmit(event) {
  event.preventDefault();
  const errorEl = document.getElementById("resumeGameError");
  const showError = (message) => {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove("hidden");
    } else {
      alert(message);
    }
  };

  const usScoreInput = document.getElementById("resumeUsScore");
  const demScoreInput = document.getElementById("resumeDemScore");

  if (!usScoreInput || !demScoreInput) {
    closeResumeGameModal();
    return;
  }

  const usScore = Number(usScoreInput.value);
  const demScore = Number(demScoreInput.value);

  const scoresAreNumbers = Number.isFinite(usScore) && Number.isFinite(demScore);
  if (!scoresAreNumbers) {
    showError("Scores must be numbers.");
    return;
  }

  const withinBounds = Math.abs(usScore) <= 1000 && Math.abs(demScore) <= 1000;
  if (!withinBounds) {
    showError("Scores should stay between -1000 and 1000.");
    return;
  }

  const isMultipleOfFive = (value) => Math.abs(value % 5) < 1e-9;
  if (!isMultipleOfFive(usScore) || !isMultipleOfFive(demScore)) {
    showError("Scores must be in increments of 5.");
    return;
  }

  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  const resumeUsPlayerOneEl = document.getElementById("resumeUsPlayerOne");
  const resumeUsPlayerTwoEl = document.getElementById("resumeUsPlayerTwo");
  const resumeDemPlayerOneEl = document.getElementById("resumeDemPlayerOne");
  const resumeDemPlayerTwoEl = document.getElementById("resumeDemPlayerTwo");

  const usPlayers = ensurePlayersArray([
    sanitizePlayerName((resumeUsPlayerOneEl && resumeUsPlayerOneEl.value) || ""),
    sanitizePlayerName((resumeUsPlayerTwoEl && resumeUsPlayerTwoEl.value) || ""),
  ]);
  const demPlayers = ensurePlayersArray([
    sanitizePlayerName((resumeDemPlayerOneEl && resumeDemPlayerOneEl.value) || ""),
    sanitizePlayerName((resumeDemPlayerTwoEl && resumeDemPlayerTwoEl.value) || ""),
  ]);

  const startingTotals = sanitizeTotals({ us: usScore, dem: demScore });
  const updates = {
    rounds: [],
    undoneRounds: [],
    startingTotals,
    gameOver: false,
    winner: null,
    victoryMethod: null,
    lastBidAmount: null,
    lastBidTeam: null,
    biddingTeam: "",
    bidAmount: "",
    showCustomBid: false,
    customBidValue: "",
    enterBidderPoints: false,
    error: "",
    startTime: null,
    accumulatedTime: 0,
    timerLastSavedAt: null,
    pendingPenalty: null,
    savedScoreInputStates: { us: null, dem: null },
  };

  updates.usPlayers = usPlayers;
  updates.demPlayers = demPlayers;

  updateState(updates);
  confettiTriggered = false;
  pendingGameAction = null;
  closeResumeGameModal();
  saveCurrentGameState();
  showSaveIndicator("Starting scores set!");
}

// Ensure resume modal helpers are available to inline handlers
if (typeof window !== "undefined") {
  window.openResumeGameModal = openResumeGameModal;
  window.closeResumeGameModal = closeResumeGameModal;
  window.handleResumeGameSubmit = handleResumeGameSubmit;
}
function openSettingsModal() {
  const mustWinToggle = document.getElementById("mustWinByBidToggle");
  if (mustWinToggle) mustWinToggle.checked = JSON.parse(localStorage.getItem(MUST_WIN_BY_BID_KEY) || "false");
  const proToggleModal = document.getElementById("proModeToggleModal");
  if (proToggleModal) proToggleModal.checked = JSON.parse(localStorage.getItem(PRO_MODE_KEY) || "false");
  const presetsContainer = document.getElementById('editPresetsContainerModal');
  if (presetsContainer) {
    presetsContainer.classList.remove('hidden'); // Always show
  }

  // Load all settings using the common function
  loadSettings();

  openModal("settingsModal");
}
function closeSettingsModal() { 
  saveSettings(); 
  closeModal("settingsModal"); 
}
function openAboutModal() { openModal("aboutModal"); }
function closeAboutModal() { closeModal("aboutModal"); }
function openStatisticsModal() { renderStatisticsContent(); openModal("statisticsModal"); }
function closeStatisticsModal() { closeModal("statisticsModal"); document.getElementById("statisticsModalContent").innerHTML = "";}
function openViewSavedGameModal() { openModal("viewSavedGameModal"); }
function closeViewSavedGameModal() { closeModal("viewSavedGameModal"); openModal("savedGamesModal"); } // Reopen parent

function openZeroPointsModal(callback) {
  let zeroPointsCallback = callback;

  // Open the modal
  openModal("zeroPointsModal");

  // Add event listeners to the buttons
  const btn180 = document.getElementById("zeroPts180Btn");
  const btn360 = document.getElementById("zeroPts360Btn");
  const btnCancel = document.getElementById("zeroPtsCancelBtn");

  // Remove existing listeners by cloning nodes
  const newBtn180 = btn180.cloneNode(true);
  const newBtn360 = btn360.cloneNode(true);
  const newBtnCancel = btnCancel.cloneNode(true);

  btn180.parentNode.replaceChild(newBtn180, btn180);
  btn360.parentNode.replaceChild(newBtn360, btn360);
  btnCancel.parentNode.replaceChild(newBtnCancel, btnCancel);

  // Add new event listeners
  newBtn180.addEventListener("click", (e) => {
    e.stopPropagation();
    closeModal("zeroPointsModal");
    if (zeroPointsCallback) zeroPointsCallback(180);
  });

  newBtn360.addEventListener("click", (e) => {
    e.stopPropagation();
    closeModal("zeroPointsModal");
    if (zeroPointsCallback) zeroPointsCallback(360);
  });

  newBtnCancel.addEventListener("click", (e) => {
    e.stopPropagation();
    closeModal("zeroPointsModal");
    // No callback on cancel
  });
}

// --- Game Actions & Logic ---
function handleCheatFlag() {
  if (!state.biddingTeam) return;  // Can't apply penalty without an active bidding team

  // Open team selection modal for table talk penalty
  openTableTalkModal();
}

function openTableTalkModal() {
  const usTeamName = state.usTeamName || "Us";
  const demTeamName = state.demTeamName || "Dem";

  const modalHtml = `
    <div id="tableTalkModal" class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 modal" role="dialog" aria-modal="true" aria-labelledby="tableTalkModalTitle">
      <div class="bg-white dark:bg-gray-800 w-full max-w-md rounded-xl shadow-lg">
        <div class="p-6">
          <h2 id="tableTalkModalTitle" class="text-xl font-bold mb-4 text-gray-800 dark:text-white text-center">Table Talk Penalty</h2>
          <p class="text-gray-600 dark:text-gray-300 mb-6 text-center">Which team engaged in table talk during this round?</p>
          <div class="space-y-3">
            <button 
              onclick="applyTableTalkPenalty('us')" 
              class="w-full text-white px-4 py-3 rounded-xl font-medium focus:outline-none hover:opacity-90 transition threed" 
              style="background-color: var(--primary-color);">
              ${usTeamName}
            </button>
            <button 
              onclick="applyTableTalkPenalty('dem')" 
              class="w-full text-white px-4 py-3 rounded-xl font-medium focus:outline-none hover:opacity-90 transition threed" 
              style="background-color: var(--accent-color);">
              ${demTeamName}
            </button>
          </div>
          <div class="mt-4 pt-4 border-t border-gray-200 dark:border-gray-600">
            <button 
              onclick="closeTableTalkModal()" 
              class="w-full bg-gray-100 hover:bg-gray-200 text-gray-800 px-4 py-2 rounded-xl font-medium focus:outline-none focus:ring-2 focus:ring-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white transition threed">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  activateModalEnvironment();
}

function closeTableTalkModal() {
  const modal = document.getElementById('tableTalkModal');
  if (modal) {
    modal.remove();
    deactivateModalEnvironment();
  }
}

function applyTableTalkPenalty(flaggedTeam) {
  const teamName = flaggedTeam === "us" 
    ? (state.usTeamName || "Us") 
    : (state.demTeamName || "Dem");

  closeTableTalkModal();

  // Get penalty type and create appropriate confirmation message
  const penaltyType = getLocalStorage(TABLE_TALK_PENALTY_TYPE_KEY, "setPoints");
  let confirmationMessage;

  console.log("Table Talk Penalty Type:", penaltyType);

  if (penaltyType === "setPoints") {
    const penaltyPoints = getLocalStorage(TABLE_TALK_PENALTY_POINTS_KEY, "180");
    console.log("Using setPoints penalty:", penaltyPoints);
    confirmationMessage = `Flag ${teamName} for table-talk? They will lose ${penaltyPoints} points.`;
  } else {
    // penaltyType === "loseBid" - they lose the bid amount in points
    const bidAmount = state.bidAmount || "0";
    console.log("Using loseBid penalty:", bidAmount);
    confirmationMessage = `Flag ${teamName} for table-talk? They will lose ${bidAmount} points (the bid amount).`;
  }

  // Show confirmation before applying penalty
  openConfirmationModal(
    confirmationMessage,
    () => { // YES
      applyCheatPenaltyRound(flaggedTeam);
      closeConfirmationModal();
      showSaveIndicator(`Penalty applied to ${teamName}`);
    },
    closeConfirmationModal // NO
  );
}

function applyCheatPenaltyRound(flaggedTeam) {
  // Get current state values
  const { biddingTeam, bidAmount, rounds, usTeamName, demTeamName } = state;
  if (!biddingTeam || !bidAmount) return;
  const numericBid = Number(bidAmount);
  const lastTotals = getLastRunningTotals();

  // Get penalty type and calculate penalty amount
  const penaltyType = getLocalStorage(TABLE_TALK_PENALTY_TYPE_KEY, "setPoints");
  let penaltyAmount;

  if (penaltyType === "setPoints") {
    penaltyAmount = parseInt(getLocalStorage(TABLE_TALK_PENALTY_POINTS_KEY, "180"));
  } else {
    penaltyAmount = numericBid; // Traditional penalty - lose the bid amount
  }

  let usEarned = 0, demEarned = 0;
  if (flaggedTeam === "us") {
    usEarned = -penaltyAmount;
    demEarned = 0;
  } else {
    usEarned = 0;
    demEarned = -penaltyAmount;
  }
  const newTotals = { us: lastTotals.us + usEarned, dem: lastTotals.dem + demEarned };
  const newRound = {
    biddingTeam,
    bidAmount: numericBid,
    usPoints: usEarned,
    demPoints: demEarned,
    runningTotals: newTotals,
    usTeamNameOnRound: usTeamName || "Us",
    demTeamNameOnRound: demTeamName || "Dem",
    penalty: "cheat",
    penaltyType: penaltyType,
    penaltyAmount: penaltyAmount
  };
  const updatedRounds = [...rounds, newRound];

  // Check for game over
  const mustWinByBid = getLocalStorage(MUST_WIN_BY_BID_KEY, false);
  let gameFinished = false, theWinner = null, victoryMethod = "Penalty: Lost Bid";
  if (Math.abs(newTotals.us - newTotals.dem) >= 1000) {
    gameFinished = true; theWinner = newTotals.us > newTotals.dem ? "us" : "dem"; victoryMethod = "1000 Point Spread";
  } else if ((biddingTeam === "us" && usEarned < 0 && newTotals.dem >= 500) || (biddingTeam === "dem" && demEarned < 0 && newTotals.us >= 500)) {
    if (!mustWinByBid) { gameFinished = true; theWinner = biddingTeam === "us" ? "dem" : "us"; victoryMethod = "Set Other Team"; }
  } else if (
// bidder wins by making their bid and crossing 500
(biddingTeam === "us" && newTotals.us >= 500 && usEarned >= numericBid) ||
(biddingTeam === "dem" && newTotals.dem >= 500 && demEarned >= numericBid)
    ) {
gameFinished   = true;
theWinner      = biddingTeam;
victoryMethod  = "Won on Bid";
    } else if (
// non-bidding team wins by setting the bidder and crossing 500
(biddingTeam === "us" && usEarned < 0 && newTotals.dem >= 500) ||
(biddingTeam === "dem" && demEarned < 0 && newTotals.us >= 500)
    ) {
gameFinished   = true;
theWinner      = biddingTeam === "us" ? "dem" : "us";
victoryMethod  = "Set Other Team";
    }
    // no "auto-win at 500+" fallback any more

  let finalAccumulated = state.accumulatedTime;
  if (state.startTime !== null && !gameFinished) { /* Time continues */ }
  else if (state.startTime !== null && gameFinished) { 
    finalAccumulated = calculateSafeTimeAccumulation(state.accumulatedTime, state.startTime);
  }

  updateState({
    rounds: updatedRounds,
    undoneRounds: [],
    gameOver: gameFinished,
    winner: theWinner,
    victoryMethod,
    biddingTeam: "",
    bidAmount: "",
    showCustomBid: false,
    customBidValue: "",
    enterBidderPoints: false,
    error: "",
    accumulatedTime: finalAccumulated,
    startTime: gameFinished ? null : state.startTime,
    pendingPenalty: null
  });
  if (gameFinished && theWinner) updateTeamsStatsOnGameEnd(theWinner);
  saveCurrentGameState();
}

function handleTeamClick(team) {
  if (state.gameOver) return;
  if (state.biddingTeam === team) { // Click active team to deselect
    state.savedScoreInputStates[team] = { bidAmount: state.bidAmount, customBidValue: state.customBidValue, showCustomBid: state.showCustomBid, enterBidderPoints: state.enterBidderPoints, error: state.error };
    updateState({ biddingTeam: "", bidAmount: "", showCustomBid: false, customBidValue: "", enterBidderPoints: false, error: ""});
  } else { // Select a new team
    state.savedScoreInputStates[team === "us" ? "dem" : "us"] = null; // Clear other team's saved input
    let newTeamState = { biddingTeam: team, bidAmount: "", showCustomBid: false, customBidValue: "", enterBidderPoints: false, error: "" };
    if (state.savedScoreInputStates[team]) { // Restore if previously selected
      newTeamState = { ...newTeamState, ...state.savedScoreInputStates[team] };
    }
    updateState(newTeamState);
  }
  ephemeralCustomBid = ""; ephemeralPoints = ""; // Clear ephemeral inputs on team switch
}
function handleBidSelect(bid) {
  if (bid === "other") {
    updateState({ showCustomBid: true, bidAmount: "", customBidValue: ephemeralCustomBid }); // Keep current custom bid if switching back
  } else {
    updateState({ showCustomBid: false, bidAmount: String(bid), customBidValue: "" });
  }
  // Update last bid info only if a numeric bid is made or custom bid is valid
  const bidVal = (bid === "other" && validateBid(state.customBidValue)==="") ? state.customBidValue : (bid !== "other" ? String(bid) : null);
  if (bidVal) updateState({ lastBidAmount: bidVal, lastBidTeam: state.biddingTeam });
  else updateState({ lastBidAmount: null, lastBidTeam: null}); // Clear if "other" is selected with no valid custom bid yet

  // Save current bid selection to localStorage
  saveCurrentGameState();
}
// numbers that are technically "valid JSON" but we *don't* want to trigger a re-render for
const BLOCKED_BIDS = new Set([5, 10, 15]);

function handleCustomBidChange(e) {
  const valStr = e.target.value.trim();   // what the user just typed
  ephemeralCustomBid = valStr;            // persist while they're editing

  /* 1 ▸ don't redraw yet if…
  – the bid isn't valid JSON-wise  OR
  – it's one of the blocked small bids                       */
  if (validateBid(valStr) !== "" || BLOCKED_BIDS.has(+valStr)) return;

  /* 2 ▸ number is good and allowed → commit to state
  (this will re-render exactly once, keeping focus alive)    */
  updateState({
    customBidValue : valStr,
    bidAmount      : valStr,
    lastBidAmount  : valStr,
    lastBidTeam    : state.biddingTeam
  });
}

function handleBiddingPointsToggle(isBiddingTeamPoints) {
  ephemeralPoints = ""; // Clear ephemeral points input
  updateState({ enterBidderPoints: isBiddingTeamPoints });
}
function handleFormSubmit(e, skipZeroCheck = false) {
  e.preventDefault();
  const { biddingTeam, bidAmount, rounds, enterBidderPoints, usTeamName, demTeamName } = state;
  const pointsInputEl = document.getElementById("pointsInput");
  if (!pointsInputEl) { updateState({ error: "Points input not found." }); return; }
  const pointsVal = pointsInputEl.value;

  if (!biddingTeam || !bidAmount) { updateState({ error: "Please select bid amount." }); return; }
  const bidError = validateBid(bidAmount);
  const pointsError = validatePoints(pointsVal);
  if (bidError || pointsError) { updateState({ error: bidError || pointsError }); return; }

  const numericBid = Number(bidAmount);
  const numericPoints = Number(pointsVal);

  if (!skipZeroCheck && numericPoints === 0) {
  const enteredForNonBidder = !state.enterBidderPoints;   // true ⇢ '0' belonged to non-bid team

  openZeroPointsModal(chosen => {
    /* commit() will run once the DOM is ready */
    const commit = () => {
  const freshInput = document.getElementById("pointsInput");
  if (freshInput) freshInput.value = String(chosen);

  /* second arg ›› skipZeroCheck = true */
  handleFormSubmit(new Event("submit"), /* skipZeroCheck */ true);
};

    /* if the '0' was for the non-bidding team we must flip the toggle first,
 which triggers a re-render → wait one tick before commit()            */
 if (enteredForNonBidder && chosen !== 0 && state.enterBidderPoints === false) {
  handleBiddingPointsToggle(true);     // causes one re-render
  setTimeout(commit, 0);               // run after new DOM appears
    } else {
  commit();                            // no toggle needed
    }
  });

  return;                                 // pause main handler until modal choice
}

  if (rounds.length === 0 && state.startTime === null) updateState({ startTime: Date.now() });

  let usEarned = 0, demEarned = 0;
  const nonBiddingTeamTotal = 180; // Standard total points in a hand excluding Rook

  if (numericPoints === 360) { // Special 360 case (usually means all points + Rook)
      if (enterBidderPoints) { // Bidding team claims 360
          biddingTeam === "us" ? (usEarned = 360, demEarned = 0) : (demEarned = 360, usEarned = 0);
      } else { // Non-bidding team claims 360
          biddingTeam === "us" ? (usEarned = -numericBid, demEarned = 360) : (demEarned = -numericBid, usEarned = 360);
      }
  } else { // Standard point distribution
      if (enterBidderPoints) { // Points entered for bidding team
          biddingTeam === "us" ? (usEarned = numericPoints, demEarned = nonBiddingTeamTotal - numericPoints) : (demEarned = numericPoints, usEarned = nonBiddingTeamTotal - numericPoints);
      } else { // Points entered for non-bidding team
          biddingTeam === "us" ? (demEarned = numericPoints, usEarned = nonBiddingTeamTotal - numericPoints) : (usEarned = numericPoints, demEarned = nonBiddingTeamTotal - numericPoints);
      }
      // Apply penalty if bid not met
      if (state.pendingPenalty && state.pendingPenalty.type === "cheat") {
    if (state.pendingPenalty.team === "us")   usEarned  = -numericBid;
    else                                      demEarned = -numericBid;
}
      if (biddingTeam === "us" && usEarned < numericBid) usEarned = -numericBid;
      else if (biddingTeam === "dem" && demEarned < numericBid) demEarned = -numericBid;
  }

  const lastTotals = getLastRunningTotals();
  const newTotals = { us: lastTotals.us + usEarned, dem: lastTotals.dem + demEarned };
  const newRound = { biddingTeam, bidAmount: numericBid, usPoints: usEarned, demPoints: demEarned, runningTotals: newTotals, usTeamNameOnRound: usTeamName || "Us", demTeamNameOnRound: demTeamName || "Dem" };
  const updatedRounds = [...rounds, newRound];

  const mustWinByBid = getLocalStorage(MUST_WIN_BY_BID_KEY, false);
  let gameFinished = false, theWinner = null, victoryMethod = "Won on Bid";

  if (Math.abs(newTotals.us - newTotals.dem) >= 1000) {
      gameFinished = true; theWinner = newTotals.us > newTotals.dem ? "us" : "dem"; victoryMethod = "1000 Point Spread";
  } else if ((biddingTeam === "us" && usEarned < 0 && newTotals.dem >= 500) || (biddingTeam === "dem" && demEarned < 0 && newTotals.us >= 500)) {
      if (!mustWinByBid) { gameFinished = true; theWinner = biddingTeam === "us" ? "dem" : "us"; victoryMethod = "Set Other Team"; }
    } else if (
// bidder wins by making their bid and crossing 500
(biddingTeam === "us" && newTotals.us >= 500 && usEarned >= numericBid) ||
(biddingTeam === "dem" && newTotals.dem >= 500 && demEarned >= numericBid)
    ) {
gameFinished   = true;
theWinner      = biddingTeam;
victoryMethod  = "Won on Bid";
    } else if (
// non-bidding team wins by setting the bidder and crossing 500
(biddingTeam === "us" && usEarned < 0 && newTotals.dem >= 500) ||
(biddingTeam === "dem" && demEarned < 0 && newTotals.us >= 500)
    ) {
gameFinished   = true;
theWinner      = biddingTeam === "us" ? "dem" : "us";
victoryMethod  = "Set Other Team";
    }

  ephemeralCustomBid = ""; ephemeralPoints = "";
  let finalAccumulated = state.accumulatedTime;
  if (state.startTime !== null && !gameFinished) { /* Time continues */ }
  else if (state.startTime !== null && gameFinished) { 
    finalAccumulated = calculateSafeTimeAccumulation(state.accumulatedTime, state.startTime);
  }

  updateState({
      rounds: updatedRounds, undoneRounds: [], gameOver: gameFinished, winner: theWinner, victoryMethod,
      biddingTeam: "", bidAmount: "", showCustomBid: false, customBidValue: "", enterBidderPoints: false, error: "",
      accumulatedTime: finalAccumulated, startTime: gameFinished ? null : state.startTime, pendingPenalty: null 
  });
  if (gameFinished && theWinner) updateTeamsStatsOnGameEnd(theWinner);
  saveCurrentGameState();
}
function handleUndo() {
  if (!state.rounds.length) return;
  const wasGameOver = state.gameOver;
  const priorWinner = state.winner;
  const teamSnapshot = {
    usPlayers: state.usPlayers,
    demPlayers: state.demPlayers,
    usDisplay: state.usTeamName,
    demDisplay: state.demTeamName,
  };
  const lastRound = state.rounds[state.rounds.length - 1];
  const newRounds = state.rounds.slice(0, -1);
  const newUndoneRounds = [...state.undoneRounds, lastRound];
  let newLastBid = null, newLastBidTeam = null;
  if (newRounds.length > 0) {
      newLastBid = String(newRounds[newRounds.length-1].bidAmount);
      newLastBidTeam = newRounds[newRounds.length-1].biddingTeam;
  }
  const nextState = { rounds: newRounds, undoneRounds: newUndoneRounds, gameOver: false, winner: null, victoryMethod: null, lastBidAmount: newLastBid, lastBidTeam: newLastBidTeam };
  if (!newRounds.length) {
      nextState.startTime = null;
      nextState.accumulatedTime = 0;
      nextState.timerLastSavedAt = null;
  }
  if (wasGameOver && priorWinner) {
    const teams = getTeamsObject();
    const reverted = applyTeamResultDelta(teams, { ...teamSnapshot, winner: priorWinner }, -1);
    if (reverted) setTeamsObject(teams);
  }
  updateState(nextState);
  saveCurrentGameState();
}
function handleRedo() {
  if (!state.undoneRounds.length) return;
  const redoRound = state.undoneRounds[state.undoneRounds.length - 1];
  const newRounds = [...state.rounds, redoRound];
  const newUndoneRounds = state.undoneRounds.slice(0, -1);

  // Re-check game over condition based on the new last round
  const lastTotals = newRounds[newRounds.length - 1].runningTotals;
  let gameOver = false, winner = null, victoryMethod = null;
  const mustWinByBid = getLocalStorage(MUST_WIN_BY_BID_KEY, false);

  if (Math.abs(lastTotals.us - lastTotals.dem) >= 1000) {
      gameOver = true; winner = lastTotals.us > lastTotals.dem ? "us" : "dem"; victoryMethod = "1000 Point Spread";
  } else if ((redoRound.biddingTeam === "us" && redoRound.usPoints < 0 && lastTotals.dem >= 500) || 
             (redoRound.biddingTeam === "dem" && redoRound.demPoints < 0 && lastTotals.us >= 500)) {
      if (!mustWinByBid) { gameOver = true; winner = redoRound.biddingTeam === "us" ? "dem" : "us"; victoryMethod = "Set Other Team"; }
  } else if (lastTotals.us >= 500 || lastTotals.dem >= 500) {
      if (mustWinByBid) {
          if ((redoRound.biddingTeam === "us" && lastTotals.us >= 500 && redoRound.usPoints >= redoRound.bidAmount) ||
              (redoRound.biddingTeam === "dem" && lastTotals.dem >= 500 && redoRound.demPoints >= redoRound.bidAmount)) {
              gameOver = true; winner = redoRound.biddingTeam; victoryMethod = "Won on Bid";
          }
      } else {
          gameOver = true; winner = lastTotals.us >= lastTotals.dem ? "us" : (lastTotals.dem > lastTotals.us ? "dem" : null);
          if (winner === null && lastTotals.us === lastTotals.dem) victoryMethod = "Tie at 500+";
          else if(winner) victoryMethod = "Reached 500+";
      }
  }

  updateState({ rounds: newRounds, undoneRounds: newUndoneRounds, gameOver, winner, victoryMethod, lastBidAmount: String(redoRound.bidAmount), lastBidTeam: redoRound.biddingTeam });
  if (gameOver && winner) updateTeamsStatsOnGameEnd(winner);
  saveCurrentGameState();
}
function handleNewGame() {
  openConfirmationModal(
    "Start a new game? Unsaved progress will be lost.",
    () => {
closeTeamSelectionModal();
resetGame();
closeConfirmationModal();
    },
    closeConfirmationModal
  );
}
function hideGameOverOverlay() {
  const overlay = document.querySelector('[data-overlay="gameover"]');
  if (overlay) overlay.classList.add('hidden');
}

function handleGameOverSaveClick(e) {
  if (e) e.preventDefault();
  hideGameOverOverlay();
  pendingGameAction = "save";
  openTeamSelectionModal();
}
function handleGameOverFixClick(e) {
  if (e) e.preventDefault();
  if (!state.rounds.length) {
      hideGameOverOverlay();
      return;
  }
  hideGameOverOverlay();
  handleUndo();
}

function handleManualSaveGame() { // Called after team names confirmed or if already set
  if (!state.usTeamName || !state.demTeamName) {
    pendingGameAction = "save"; openTeamSelectionModal(); return;
  }
  if (!state.rounds.length) return;

  let finalAccumulated = calculateSafeTimeAccumulation(state.accumulatedTime, state.startTime);

  const lastRoundTotals = getCurrentTotals();
  const usPlayers = ensurePlayersArray(state.usPlayers);
  const demPlayers = ensurePlayersArray(state.demPlayers);
  const usDisplay = deriveTeamDisplay(usPlayers, state.usTeamName || "Us") || "Us";
  const demDisplay = deriveTeamDisplay(demPlayers, state.demTeamName || "Dem") || "Dem";
  const usTeamKey = buildTeamKey(usPlayers) || null;
  const demTeamKey = buildTeamKey(demPlayers) || null;
  const gameObj = {
      usTeamName: usDisplay,
      demTeamName: demDisplay,
      usPlayers,
      demPlayers,
      usTeamKey,
      demTeamKey,
      rounds: state.rounds,
      finalScore: lastRoundTotals,
      startingTotals: sanitizeTotals(state.startingTotals),
      winner: state.winner, victoryMethod: state.victoryMethod,
      timestamp: new Date().toISOString(), durationMs: finalAccumulated,
      // Simplified playerStats, more complex stats are in general statistics
      playerStats: { 
          [usDisplay]: { totalPoints: lastRoundTotals.us, wins: state.winner === "us" ? 1 : 0 },
          [demDisplay]: { totalPoints: lastRoundTotals.dem, wins: state.winner === "dem" ? 1 : 0 }
      }
  };
  const savedGames = getLocalStorage("savedGames", []);
  savedGames.push(gameObj);
  setLocalStorage("savedGames", savedGames);
  showSaveIndicator("Game Saved!");
  resetGame(); // Resets state and clears active game from storage
  confettiTriggered = false;
  pendingGameAction = null;
}
function handleFreezerGame() {
  if (state.gameOver || !state.rounds.length) {
    alert("No active game to freeze."); return;
  }
  if (!state.usTeamName || !state.demTeamName) {
    pendingGameAction = "freeze"; openTeamSelectionModal(); return;
  }
  confirmFreeze(); // Ask for confirmation
}
function confirmFreeze() {
   openConfirmationModal(
      "Freeze this game? It will be moved to Freezer Games and current game will reset.",
      () => { freezeCurrentGame(); closeConfirmationModal(); closeMenuOverlay(); },
      closeConfirmationModal
  );
}
function freezeCurrentGame() {
  let finalAccumulated = calculateSafeTimeAccumulation(state.accumulatedTime, state.startTime);
  const finalScore = getCurrentTotals();
  const lastRound = state.rounds.length ? state.rounds[state.rounds.length-1] : {};
  const usPlayers = ensurePlayersArray(state.usPlayers);
  const demPlayers = ensurePlayersArray(state.demPlayers);
  const usDisplay = deriveTeamDisplay(usPlayers, state.usTeamName || "Us") || "Us";
  const demDisplay = deriveTeamDisplay(demPlayers, state.demTeamName || "Dem") || "Dem";
  const usTeamKey = buildTeamKey(usPlayers) || null;
  const demTeamKey = buildTeamKey(demPlayers) || null;

  const frozenGame = {
      name: `FROZEN-${new Date().toLocaleTimeString()}`, // More readable name
      usName: usDisplay,
      demName: demDisplay,
      usPlayers,
      demPlayers,
      usTeamKey,
      demTeamKey,
      finalScore, // Current scores when frozen
      lastBid: lastRound.bidAmount ? `${lastRound.bidAmount} (${lastRound.biddingTeam === "us" ? usDisplay : demDisplay})` : "N/A",
      winner: null, victoryMethod: null, // Game is not over
      rounds: state.rounds,
      startingTotals: sanitizeTotals(state.startingTotals),
      timestamp: new Date().toISOString(),
      accumulatedTime: finalAccumulated,
      // Store necessary state to resume
      biddingTeam: state.biddingTeam, bidAmount: state.bidAmount,
      customBidValue: state.customBidValue, showCustomBid: state.showCustomBid,
      enterBidderPoints: state.enterBidderPoints, lastBidAmount: state.lastBidAmount, lastBidTeam: state.lastBidTeam
  };
  const freezerGames = getLocalStorage("freezerGames");
  freezerGames.unshift(frozenGame); // Add to beginning
  setLocalStorage("freezerGames", freezerGames);
  showSaveIndicator("Game Frozen!");
  resetGame(); // Resets state and clears active game
  pendingGameAction = null;
}
function loadFreezerGame(index) {
  const freezerGames = getLocalStorage("freezerGames");
  const chosen = freezerGames[index];
  if (!chosen) return;
  openConfirmationModal(
    `Load frozen game "${chosen.name || 'Untitled'}"? Current game will be overwritten.`,
    () => {
      closeConfirmationModal();
      const chosenUsPlayers = ensurePlayersArray(chosen.usPlayers || parseLegacyTeamName(chosen.usName));
      const chosenDemPlayers = ensurePlayersArray(chosen.demPlayers || parseLegacyTeamName(chosen.demName));
      const chosenUsName = deriveTeamDisplay(chosenUsPlayers, chosen.usName || "Us") || "Us";
      const chosenDemName = deriveTeamDisplay(chosenDemPlayers, chosen.demName || "Dem") || "Dem";
      // Restore all relevant game state aspects
      updateState({
          rounds: chosen.rounds || [],
          startingTotals: sanitizeTotals(chosen.startingTotals),
          gameOver: false, // Frozen games are not over
          winner: null, victoryMethod: null,
          biddingTeam: chosen.biddingTeam || "",
          bidAmount: chosen.bidAmount || "",
          showCustomBid: chosen.showCustomBid || false,
          customBidValue: chosen.customBidValue || "",
          enterBidderPoints: chosen.enterBidderPoints || false,
          error: "", // Clear any previous error
          lastBidAmount: chosen.lastBidAmount || null,
          lastBidTeam: chosen.lastBidTeam || null,
          usPlayers: chosenUsPlayers,
          demPlayers: chosenDemPlayers,
          usTeamName: chosenUsName,
          demTeamName: chosenDemName,
          accumulatedTime: Math.min(chosen.accumulatedTime || 0, MAX_GAME_TIME_MS), // Cap accumulated time
          startTime: Date.now(), // Restart timer
          showWinProbability: JSON.parse(localStorage.getItem(PRO_MODE_KEY)) || false,
          undoneRounds: [] // Clear any undone rounds from previous state
      });
      freezerGames.splice(index, 1); // Remove from freezer
      setLocalStorage("freezerGames", freezerGames);
      closeSavedGamesModal();
      saveCurrentGameState(); // Save the now active game
      confettiTriggered = false;
    },
    closeConfirmationModal
  );
}
function viewSavedGame(originalIndex) { // originalIndex is from the full savedGames list
  const savedGames = getLocalStorage("savedGames"); // Get the full list
  // Find the actual game object by its original index if filtering/sorting was applied
  // This requires the renderSavedGames to pass the original index or unique ID.
  // For simplicity, assuming originalIndex is correct for the current display of `savedGames`.
  // A robust solution would involve passing a game ID if the list is dynamically filtered/sorted.
  // Let's assume `renderSavedGames` provides an index that's valid for `getLocalStorage("savedGames")[index]`
  const chosen = savedGames[originalIndex];

  if (!chosen) return;
  document.getElementById("viewSavedGameDetails").innerHTML = renderReadOnlyGameDetails(chosen);
  openViewSavedGameModal();
}
function deleteGame(storageKey, index, descriptor) {
  const items = getLocalStorage(storageKey);
  openConfirmationModal(`Delete this ${descriptor}?`, () => {
    items.splice(index, 1);
    setLocalStorage(storageKey, items);
    if (storageKey === "savedGames") recalcTeamsStats(); // Only if deleting a completed game
    closeConfirmationModal();
    // Re-render the list in the modal
    if (document.getElementById("savedGamesModal") && !document.getElementById("savedGamesModal").classList.contains("hidden")) {
      updateGamesCount();
      renderGamesWithFilter();
    }
  }, closeConfirmationModal);
}
function deleteSavedGame(index) { deleteGame("savedGames", index, "completed game"); }
function deleteFreezerGame(index) { deleteGame("freezerGames", index, "frozen game"); }

// --- Settings & Pro Mode ---
function saveSettings() {
  const mustWinToggle = document.getElementById("mustWinByBidToggle");
  if (mustWinToggle) localStorage.setItem(MUST_WIN_BY_BID_KEY, mustWinToggle.checked);

  const penaltySelect = document.getElementById("tableTalkPenaltySelect");
  if (penaltySelect) setLocalStorage(TABLE_TALK_PENALTY_TYPE_KEY, penaltySelect.value);

  const penaltyPointsInput = document.getElementById("penaltyPointsInput");
  if (penaltyPointsInput) {
    let points = parseInt(penaltyPointsInput.value) || 180;

    // Validate and round to nearest multiple of 5
    if (points < 5) points = 5;
    if (points > 500) points = 500;
    if (points % 5 !== 0) {
      points = Math.round(points / 5) * 5;
      penaltyPointsInput.value = points; // Update the input to show corrected value
    }

    setLocalStorage(TABLE_TALK_PENALTY_POINTS_KEY, points);
  }

  showSaveIndicator("Settings Saved");
}
function updateProModeUI(isProMode) {
  const presetsContainer = document.getElementById('editPresetsContainerModal');
  if (presetsContainer) {
    presetsContainer.classList.remove('hidden'); // Always show
  }
  const proToggleModal = document.getElementById("proModeToggleModal");
  if (proToggleModal) proToggleModal.checked = isProMode;
  updateState({ showWinProbability: isProMode }); // Update live state
}
function toggleProMode(checkbox) {
  const isPro = checkbox.checked;
  localStorage.setItem(PRO_MODE_KEY, isPro);
  updateProModeUI(isPro);
  saveCurrentGameState(); // Save state with new pro mode setting
}

function handleTableTalkPenaltyChange() {
  const penaltySelect = document.getElementById("tableTalkPenaltySelect");
  const customPointsDiv = document.getElementById("customPenaltyPoints");

  if (penaltySelect && customPointsDiv) {
    if (penaltySelect.value === "setPoints") {
      customPointsDiv.classList.remove("hidden");
    } else {
      customPointsDiv.classList.add("hidden");
    }

    // Save the penalty type setting
    console.log("Saving Table Talk Penalty Type:", penaltySelect.value);
    setLocalStorage(TABLE_TALK_PENALTY_TYPE_KEY, penaltySelect.value);
  }
}

function handlePenaltyPointsChange() {
  const penaltyPointsInput = document.getElementById("penaltyPointsInput");
  if (penaltyPointsInput) {
    let points = parseInt(penaltyPointsInput.value);

    // Validate the points
    if (isNaN(points) || points < 5 || points > 500) {
      points = 180; // Default value
      penaltyPointsInput.value = points;
    }

    // Ensure it's a multiple of 5
    if (points % 5 !== 0) {
      points = Math.round(points / 5) * 5;
      penaltyPointsInput.value = points;
    }

    // Save the penalty points setting
    console.log("Saving Table Talk Penalty Points:", points);
    setLocalStorage(TABLE_TALK_PENALTY_POINTS_KEY, points.toString());
  }
}

// --- Validation ---
function validateBid(bidStr) {
  const bidNum = Number(bidStr);
  if (isNaN(bidNum)) return "Bid must be a number.";
  if (bidNum <= 0) return "Bid must be > 0.";
  if (bidNum % 5 !== 0) return "Bid must be multiple of 5.";
  if (bidNum > 360) return "Bid max 360.";
  if (bidNum > 180 && bidNum < 360) return "Bids between 180 and 360 are not allowed.";
  return "";
}
function validatePoints(pointsStr) {
  const pointsNum = Number(pointsStr);
  if (isNaN(pointsNum)) return "Points must be a number.";
  if (pointsNum % 5 !== 0) return "Points must be multiple of 5.";
  if (pointsNum !== 360 && (pointsNum < 0 || pointsNum > 180)) return "Points 0-180 or 360.";
  return "";
}

// --- Misc UI & Utility ---
function showVersionNum() {
  alert("Version 1.5.0 (Build 1) Adds a new glass-like feel, point differential display, individual statistics, cleaner team handling & more bug fixes / UI improvements.");
}
function renderTimeWarning() {
  if (!state.startTime || state.gameOver) return "";

  const currentTime = getCurrentGameTime();
  const roundTime = Date.now() - state.startTime;

           // Warning thresholds
   const ROUND_WARNING_TIME = 90 * 60 * 1000; // 90 minutes
   const GAME_WARNING_TIME = 8 * 60 * 60 * 1000; // 8 hours

  let warningMessage = "";
  let warningLevel = "";

  if (roundTime > ROUND_WARNING_TIME || currentTime > GAME_WARNING_TIME) {
    if (roundTime > MAX_ROUND_TIME_MS * 0.9) {
      warningMessage = "⚠️ Round time is very high! Consider starting a new game.";
      warningLevel = "danger";
    } else if (currentTime > MAX_GAME_TIME_MS * 0.9) {
      warningMessage = "⚠️ Game time is very high! Consider starting a new game.";
      warningLevel = "danger";
    } else if (roundTime > ROUND_WARNING_TIME) {
      warningMessage = "⏰ Round has been active for " + formatDuration(roundTime);
      warningLevel = "warning";
    } else if (currentTime > GAME_WARNING_TIME) {
      warningMessage = "⏰ Game has been active for " + formatDuration(currentTime);
      warningLevel = "warning";
    }
  }

  if (!warningMessage) return "";

  const bgColor = warningLevel === "danger" ? "bg-red-100 border-red-300 text-red-800 dark:bg-red-900 dark:border-red-700 dark:text-red-300" : "bg-yellow-100 border-yellow-300 text-yellow-800 dark:bg-yellow-900 dark:border-yellow-700 dark:text-yellow-300";

  return `
    <div class="mx-4 mb-4 p-3 rounded-lg border ${bgColor} text-sm text-center">
      ${warningMessage}
    </div>
  `;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0:00";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  const s = secs % 60;
  const m = mins % 60;
  return `${hrs > 0 ? hrs + ':' : ''}${hrs > 0 && m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

// --- Probability Breakdown Functions ---
function openProbabilityModal() {
  const modalHtml = `
    <div id="probabilityModal" class="probability-modal fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 modal" role="dialog" aria-modal="true" aria-labelledby="probabilityModalTitle">
      <div class="probability-modal-content bg-white dark:bg-gray-800 w-full max-w-lg rounded-xl shadow-lg transform transition-all">
        <div class="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 id="probabilityModalTitle" class="text-xl font-bold text-gray-800 dark:text-white">Win Probability Breakdown</h2>
          <button type="button" onclick="closeProbabilityModal()" class="text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-full p-1">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="p-4">
          ${generateProbabilityBreakdown()}
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  activateModalEnvironment();
}

function closeProbabilityModal() {
  const modal = document.getElementById('probabilityModal');
  if (modal) {
    modal.remove();
    deactivateModalEnvironment();
  }
}

function generateProbabilityBreakdown() {
  if (!state.showWinProbability || !state.rounds || state.rounds.length === 0 || state.gameOver) {
    return "";
  }

  const historicalGames = getLocalStorage("savedGames");
  const winProb = calculateWinProbability(state, historicalGames);

  // Get current game state
  const lastRound = state.rounds[state.rounds.length - 1];
  const currentScores = lastRound.runningTotals || { us: 0, dem: 0 };
  const scoreDiff = currentScores.us - currentScores.dem;
  const roundsPlayed = state.rounds.length;
  const labelUs = state.usTeamName || "Us";
  const labelDem = state.demTeamName || "Dem";

  return renderProbabilityBreakdown(scoreDiff, roundsPlayed, labelUs, labelDem, winProb, historicalGames, currentScores);
}

function populateTeamSelects() {
  const teamsObj = getTeamsObject();
  const entrySortFn = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const teamEntries = Object.entries(teamsObj).map(([key, value]) => ({
    key,
    players: ensurePlayersArray(value.players),
    displayName: deriveTeamDisplay(value.players, value.displayName || ''),
  })).filter(entry => entry.displayName).sort((a, b) => entrySortFn(a.displayName, b.displayName));

  const configureTeamSection = (selectId, inputIds, currentPlayers) => {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) return;
    selectEl.innerHTML = '<option value="">-- Select saved pairing --</option>';
    teamEntries.forEach(entry => {
      const option = new Option(entry.displayName, entry.key);
      selectEl.add(option);
    });

    const currentKey = buildTeamKey(currentPlayers);
    if (currentKey && teamsObj[currentKey]) {
      selectEl.value = currentKey;
    } else {
      selectEl.value = "";
    }

    selectEl.onchange = () => {
      const chosen = teamsObj[selectEl.value];
      if (!chosen) return;
      const chosenPlayers = ensurePlayersArray(chosen.players);
      inputIds.forEach((id, idx) => {
        const inputEl = document.getElementById(id);
        if (inputEl) inputEl.value = chosenPlayers[idx] || "";
      });
    };

    inputIds.forEach((id, idx) => {
      const inputEl = document.getElementById(id);
      if (inputEl) inputEl.value = sanitizePlayerName(currentPlayers[idx] || "");
    });
  };

  configureTeamSection("selectUsTeam", ["usPlayerOne", "usPlayerTwo"], ensurePlayersArray(state.usPlayers));
  configureTeamSection("selectDemTeam", ["demPlayerOne", "demPlayerTwo"], ensurePlayersArray(state.demPlayers));

  const playerSuggestions = new Set();
  teamEntries.forEach(entry => entry.players.forEach(name => { if (name) playerSuggestions.add(name); }));
  ensurePlayersArray(state.usPlayers).forEach(name => { if (name) playerSuggestions.add(name); });
  ensurePlayersArray(state.demPlayers).forEach(name => { if (name) playerSuggestions.add(name); });
  const datalist = document.getElementById("playerNameSuggestions");
  if (datalist) {
    datalist.innerHTML = Array.from(playerSuggestions)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map(name => `<option value="${name.replace(/"/g, '&quot;')}"></option>`)
      .join("\n");
  }
}
function handleTeamSelectionSubmit(e) {
  e.preventDefault();

  const usPlayerOneInput = document.getElementById("usPlayerOne");
  const usPlayerTwoInput = document.getElementById("usPlayerTwo");
  const demPlayerOneInput = document.getElementById("demPlayerOne");
  const demPlayerTwoInput = document.getElementById("demPlayerTwo");

  const usPlayers = ensurePlayersArray([
    usPlayerOneInput ? usPlayerOneInput.value : "",
    usPlayerTwoInput ? usPlayerTwoInput.value : "",
  ]);
  const demPlayers = ensurePlayersArray([
    demPlayerOneInput ? demPlayerOneInput.value : "",
    demPlayerTwoInput ? demPlayerTwoInput.value : "",
  ]);

  if (!usPlayers[0] || !usPlayers[1]) {
    alert("Please enter both player names for Team 'Us'.");
    return;
  }
  if (!demPlayers[0] || !demPlayers[1]) {
    alert("Please enter both player names for Team 'Dem'.");
    return;
  }
  if (usPlayers[0].toLowerCase() === usPlayers[1].toLowerCase()) {
    alert("Team 'Us' needs two different players.");
    return;
  }
  if (demPlayers[0].toLowerCase() === demPlayers[1].toLowerCase()) {
    alert("Team 'Dem' needs two different players.");
    return;
  }

  const usKey = buildTeamKey(usPlayers);
  const demKey = buildTeamKey(demPlayers);
  if (!usKey || !demKey) {
    alert("Problem building team combinations. Please check the names and try again.");
    return;
  }
  if (usKey === demKey) {
    alert("Both teams cannot have the same two players.");
    return;
  }

  addTeamIfNotExists(usPlayers, formatTeamDisplay(usPlayers));
  addTeamIfNotExists(demPlayers, formatTeamDisplay(demPlayers));
  updateState({ usPlayers, demPlayers });
  saveCurrentGameState();
  closeTeamSelectionModal();
  if (pendingGameAction === "freeze") { confirmFreeze(); }
  else if (pendingGameAction === "save") { handleManualSaveGame(); }
  pendingGameAction = null;
}
function getDeviceDetails() {
  let appVersion = "N/A";
  try {
      const verEl = document.querySelector('.absolute.top-0.right-0 p');
      if (verEl && verEl.textContent.includes('version')) appVersion = verEl.textContent.trim();
  } catch (e) { console.warn("Could not get app version:", e); }

  let fbStatus = "N/A", fbUserId = "N/A", fbIsAnon = "N/A";
  if (window.firebaseAuth) {
      fbStatus = window.firebaseReady ? "Ready" : "Not Ready/Offline";
      if (window.firebaseAuth.currentUser) {
          fbUserId = window.firebaseAuth.currentUser.uid;
          fbIsAnon = String(window.firebaseAuth.currentUser.isAnonymous);
      }
  }
  return `User Agent: ${navigator.userAgent}\nScreen: ${window.innerWidth}x${window.innerHeight} (DPR: ${window.devicePixelRatio})\nApp Version: ${appVersion}\nDark Mode: ${document.documentElement.classList.contains('dark')}\nPro Mode: ${localStorage.getItem(PRO_MODE_KEY) === 'true'}\nFirebase: ${fbStatus} (User: ${fbUserId}, Anon: ${fbIsAnon})\nTimestamp: ${new Date().toISOString()}`;
}
function handleBugReportClick() {
    const recipient = "heinonenmh@gmail.com";
    const subject = "Rook Score App - Bug Report";
    const deviceDetails = getDeviceDetails();
    let appStateString = "Could not retrieve app state.";
    try {
      const roundsArray = Array.isArray(state.rounds) ? state.rounds : [];
      const lastRound = roundsArray.length ? roundsArray[roundsArray.length - 1] : null;
      const lastTotals = lastRound && lastRound.runningTotals ? lastRound.runningTotals : {};
      const lastUsScore = typeof lastTotals.us === "number" ? lastTotals.us : 0;
      const lastDemScore = typeof lastTotals.dem === "number" ? lastTotals.dem : 0;
      const roundsPlayed = roundsArray.length;
      appStateString = [
        `Teams: ${state.usTeamName || "Us"} vs ${state.demTeamName || "Dem"}`,
        `Scores: Us ${lastUsScore} - Dem ${lastDemScore}`,
        `Rounds played: ${roundsPlayed}`,
        `Game Over: ${state.gameOver ? "Yes" : "No"}`,
        `Winner: ${state.winner || "N/A"}`,
        `Victory Method: ${state.victoryMethod || "N/A"}`
      ].join('\n');
    } catch (e) {
      appStateString = `Error summarizing state: ${e.message}`;
    }
    const body = `Please describe the bug:\n[ ** Enter Description Here ** ]\n\n--- Device & App Info ---\n${deviceDetails}\n\n--- App State ---\n${appStateString}\n\n(Review before sending)`;
    const mailtoLink = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (mailtoLink.length > 2000) {
        alert("Bug report details are very long. Please copy the following details manually into your email client if the body is incomplete.");
        console.log("--- COPY BUG REPORT DETAILS BELOW ---");
        console.log(body); // Log to console as fallback
    }
    window.location.href = mailtoLink;
}

// --- Rendering Functions ---
// (renderApp, renderTeamCard, renderRoundCard, renderErrorAlert, renderScoreInputCard, renderPointsInput, renderHistoryCard, renderGameOverOverlay, renderReadOnlyGameDetails, renderSavedGames, renderFreezerGames, renderStatisticsContent, renderTeamStatsTable)
// These are substantial and involve generating HTML. They are defined below.
function renderApp() {
  const { error, rounds, bidAmount, showCustomBid, biddingTeam, customBidValue, gameOver, lastBidAmount, lastBidTeam } = state;
  const totals = getCurrentTotals();
  const roundNumber = rounds.length + 1;

  const shouldShowWinProbability = state.showWinProbability && !gameOver && rounds.length > 0;
  const historicalGames = shouldShowWinProbability ? getLocalStorage("savedGames") : null;
  const winProb = shouldShowWinProbability ? calculateWinProbability(state, historicalGames) : null;

  let lastBidDisplayHtml = "";
  // Show "Current Bid" if a bid is being selected
  if (biddingTeam && (bidAmount || (showCustomBid && customBidValue))) {
      const currentBidDisplayAmount = bidAmount || customBidValue;
      const currentBiddingTeamName = biddingTeam === "us" ? (state.usTeamName || "Us") : (state.demTeamName || "Dem");
      const arrow = biddingTeam === "us" ? "←" : "→";
      const teamColor = biddingTeam === "us" ? 'var(--primary-color)' : 'var(--accent-color)';
      if (validateBid(currentBidDisplayAmount) === "") { // Only display if valid
          lastBidDisplayHtml = `<div class=\"mt-1 text-xs text-white\">Current Bid: <span class=\"font-semibold\" style=\"color: ${teamColor};\">${currentBiddingTeamName}</span><br><span class=\"inline-block mt-0.5 font-bold\">${currentBidDisplayAmount} <span>${arrow}</span></span></div>`;
      }
  }
  // If not, show "Last Bid" from the last completed round
  else if (state.rounds.length > 0) {
      const lastRound = state.rounds[state.rounds.length - 1];
      const lastBidAmount = lastRound.bidAmount;
      const lastBidTeam = lastRound.biddingTeam;
      const teamName = lastBidTeam === "us" ? (state.usTeamName || "Us") : (state.demTeamName || "Dem");
      const arrow = lastBidTeam === "us" ? "←" : "→";
      const teamColor = lastBidTeam === "us" ? 'var(--primary-color)' : 'var(--accent-color)';
      lastBidDisplayHtml = `<div class=\"mt-1 text-xs text-white\">Last Bid: <span class=\"font-semibold\" style=\"color: ${teamColor};\">${teamName}</span><br><span class=\"inline-block mt-0.5 font-bold\">${lastBidAmount} <span>${arrow}</span></span></div>`;
  }


  document.getElementById("app").innerHTML = `
    <div class="text-center space-y-2">
      <h1 class="font-extrabold text-5xl sm:text-6xl text-gray-800 dark:text-white">Rook!</h1>
      <p class="text-md sm:text-lg text-gray-600 dark:text-white">Tap a team to start a bid!</p>
    </div>
    ${renderTimeWarning()}
    <div class="flex flex-row gap-3 flex-wrap justify-center items-stretch">
      ${renderTeamCard("us", totals.us, winProb)}
      ${renderRoundCard(roundNumber, lastBidDisplayHtml)}
      ${renderTeamCard("dem", totals.dem, winProb)}
    </div>
    ${error ? `<div>${renderErrorAlert(error)}</div>` : ""}
    ${renderScoreInputCard()}
    ${renderHistoryCard()}
    ${renderGameOverOverlay()}
  `;
  if (gameOver && !confettiTriggered) {
    confettiTriggered = true;
    if (typeof confetti === 'function') confetti({ particleCount: 200, spread: 70, origin: { y: 0.6 } });
  }
}
function renderTeamCard(teamKey, score, winProb) {
  const isSelected = state.biddingTeam === teamKey;
  const teamLabel = teamKey === "us" ? (state.usTeamName || "Us") : (state.demTeamName || "Dem");
  const colorClass = teamKey === "us" ? "bg-primary" : "bg-accent";
  const selectedEffect = isSelected ? "sunken-selected" : "";
  let winProbDisplay = "";
  if (winProb) {
    const prob = teamKey === "us" ? winProb.us : winProb.dem;
    const teamColorVar = teamKey === "us" ? "var(--primary-color)" : "var(--accent-color)";
    const brightness = isSelected ? "brightness(0.7)" : "brightness(0.85)"; // Darken more when selected
    // Inner div for probability text to ensure z-index works with sunken-selected's ::after
    winProbDisplay = `
      <div class="mt-1 text-xs rounded-full px-2 py-1 relative" style="background-color: ${teamColorVar}; filter: ${brightness};">
        <span class="relative font-medium" style="color: #FFF; z-index: 1;">Win: ${prob.toFixed(1)}%</span>
      </div>`;
  }
  return `
    <button type="button"
    class="${colorClass} ${selectedEffect} threed text-white cursor-pointer transition-all rounded-xl shadow-md flex flex-col items-center justify-center flex-1 min-w-[calc(33%-1rem)] sm:min-w-0 w-auto h-32 p-2"
    onclick="handleTeamClick('${teamKey}')"
    aria-pressed="${isSelected}" aria-label="Select ${teamLabel}">
    <div class="text-center">
<h2 class="text-base sm:text-xl font-semibold truncate max-w-[100px] sm:max-w-[120px]">${teamLabel}</h2>
<p class="text-2xl font-bold">${score}</p>
${winProbDisplay}
    </div>
  </button>`;
}
function renderRoundCard(roundNumber, lastBidDisplayHtml) {
  return `
    <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow threed flex flex-col items-center justify-center p-3 flex-1 min-w-[calc(33%-1rem)] sm:min-w-0 w-auto h-32">
      <div class="text-center space-y-1">
        <h2 class="text-xl font-bold text-gray-700 dark:text-white">Round</h2>
        <p class="text-2xl font-extrabold text-gray-900 dark:text-white">${roundNumber}</p>
        ${lastBidDisplayHtml}
      </div>
    </div>`;
}
function renderErrorAlert(errorMessage) {
  return `<div role="alert" class="flex items-center border border-red-400 rounded-xl p-4 bg-red-50 text-red-700 space-x-3 dark:bg-red-900/50 dark:border-red-600 dark:text-red-300">${Icons.AlertCircle}<div class="flex-1">${errorMessage}</div></div>`;
}
function renderScoreInputCard() {
  const { biddingTeam, bidAmount, showCustomBid, customBidValue, rounds, gameOver, undoneRounds, pendingPenalty } = state;
  if (gameOver || !biddingTeam) { scoreCardHasAnimated = false; return ""; }
  const fadeClass = scoreCardHasAnimated ? "" : "animate-fadeIn";
  scoreCardHasAnimated = true;
  const hasBid = bidAmount || (showCustomBid && validateBid(customBidValue) === "");
  const biddingTeamDisplayName = biddingTeam === "us" ? (state.usTeamName || "Us") : (state.demTeamName || "Dem");
  const focusRingColor = biddingTeam === "us" ? "focus:ring-blue-500 dark:focus:ring-blue-400" : "focus:ring-red-500 dark:focus:ring-red-400";
  const penaltyActive = pendingPenalty && pendingPenalty.team === biddingTeam && pendingPenalty.type === "cheat";
  const penaltyBtnClass = penaltyActive
    ? "flex items-center border border-orange-400 rounded px-2 py-1 text-sm text-orange-700 bg-orange-100 hover:bg-orange-200 transition focus:outline-none focus:ring-2 focus:ring-orange-500 dark:bg-orange-900/60 dark:text-orange-300 threed disabled:opacity-50 disabled:cursor-not-allowed"
    : "flex items-center border border-gray-400 rounded px-2 py-1 text-sm text-gray-600 bg-gray-50 hover:bg-gray-100 transition focus:outline-none focus:ring-2 focus:ring-gray-500 dark:bg-gray-800/50 dark:text-gray-300 threed disabled:opacity-50 disabled:cursor-not-allowed";
  const penaltyBtnOnClick = penaltyActive ? 'undoPenaltyFlag()' : 'handleCheatFlag()';
  return `
    <div class="${fadeClass} bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow">
      <div class="border-b border-gray-200 p-3 flex justify-between items-center dark:border-gray-700">
        <h2 class="text-lg font-bold text-gray-800 dark:text-white">Enter Bid for ${biddingTeamDisplayName}</h2>
        <div class="flex space-x-2">
          <button type="button" class="flex items-center border border-gray-300 rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 transition disabled:opacity-50 focus:outline-none focus:ring-2 ${focusRingColor} dark:border-gray-600 dark:text-white dark:hover:bg-gray-700 threed" onclick="handleUndo(event)" ${!rounds.length ? "disabled" : ""} title="Undo">${Icons.Undo}Undo</button>
          <button type="button" class="flex items-center border border-gray-300 rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 transition disabled:opacity-50 focus:outline-none focus:ring-2 ${focusRingColor} dark:border-gray-600 dark:text-white dark:hover:bg-gray-700 threed" onclick="handleRedo(event)" ${!undoneRounds.length ? "disabled" : ""} title="Redo">${Icons.Redo}Redo</button>
          <button type="button"
    class="${penaltyBtnClass}"
    onclick="${penaltyBtnOnClick}"
    ${!hasBid ? "disabled" : ""}
    title="Flag Table Talk - Choose Team">
<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10v4a1 1 0 0 0 1 1h2l5 3V6L6 9H4a1 1 0 0 0-1 1zm13-1.5v5a2.5 2.5 0 0 0 0-5z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 12a4 4 0 0 0 4-4" stroke="currentColor" stroke-width="2" fill="none"/></svg>
  </button>
        </div>
      </div>
      <div class="p-4 score-input-container show">
        <form onsubmit="handleFormSubmit(event)" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1.5 text-gray-700 dark:text-white">Bid Amount</label>
            <div class="flex flex-wrap gap-2">
              ${presetBids.map(b => {
                const isActive = b === "other" ? showCustomBid : (state.bidAmount === String(b) && !showCustomBid);
                const btnBase = `px-3 py-1.5 text-sm font-medium threed rounded-lg transition focus:outline-none focus:ring-2 ${focusRingColor}`;
                const btnActive = `${biddingTeam === "us" ? "bg-primary" : "bg-accent"} text-white shadow hover:brightness-95`;
                const btnInactive = `bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 dark:bg-gray-700 dark:border-gray-500 dark:text-white dark:hover:bg-gray-600`;
                return `<button type="button" class="${btnBase} ${isActive ? btnActive : btnInactive}" onclick="handleBidSelect('${b}')" aria-pressed="${isActive}">${b === "other" ? "Other" : b}</button>`;
              }).join("")}
            </div>
            ${showCustomBid ? `<div class="mt-2"><input type="number" inputmode="numeric" pattern="[0-9]*" step="5" value="${customBidValue}" oninput="handleCustomBidChange(event)" placeholder="Enter custom bid" class="w-full sm:w-1/2 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 ${focusRingColor} transition dark:bg-gray-700 dark:border-gray-500 dark:text-white" /></div>` : ""}
          </div>
          ${(bidAmount || (showCustomBid && customBidValue && validateBid(customBidValue)==="")) ? renderPointsInput() : ""}
        </form>
      </div>
    </div>`;
}
function renderPointsInput() {
  const { biddingTeam, enterBidderPoints, usTeamName, demTeamName } = state;
  const biddingTeamName = biddingTeam === "us" ? (usTeamName || "Us") : (demTeamName || "Dem");
  const nonBiddingTeamName = biddingTeam === "us" ? (demTeamName || "Dem") : (usTeamName || "Us");
  const labelText = enterBidderPoints ? `${biddingTeamName} Points (Bidding)` : `${nonBiddingTeamName} Points (Non-Bidding)`;

  // Determine active button based on whose points are being entered
  const biddingTeamButtonActive = enterBidderPoints;
  const nonBiddingTeamButtonActive = !enterBidderPoints;

  // Team-specific colors for active buttons
  const biddingTeamColorClass = biddingTeam === "us" ? "bg-primary" : "bg-accent";
  const nonBiddingTeamColorClass = biddingTeam === "us" ? "bg-accent" : "bg-primary";

  const focusRingColor = biddingTeam === "us" ? "focus:ring-blue-500 dark:focus:ring-blue-400" : "focus:ring-red-500 dark:focus:ring-red-400";

  return `
    <div class="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700 mt-4">
      <div>
        <label class="block text-sm font-medium mb-1.5 text-gray-700 dark:text-white">Enter Points For</label>
        <div class="flex gap-3">
          <button type="button" class="flex-1 rounded-full px-3 py-1.5 text-sm font-medium threed transition focus:outline-none focus:ring-2 focus:ring-opacity-50 ${biddingTeamButtonActive ? `${biddingTeamColorClass} text-white shadow hover:brightness-95` : `bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 dark:bg-gray-700 dark:border-gray-500 dark:text-white dark:hover:bg-gray-600`} ${focusRingColor}" onclick="handleBiddingPointsToggle(true)" aria-pressed="${biddingTeamButtonActive}">${biddingTeamName}</button>
          <button type="button" class="flex-1 rounded-full px-3 py-1.5 text-sm font-medium threed transition focus:outline-none focus:ring-2 focus:ring-opacity-50 ${nonBiddingTeamButtonActive ? `${nonBiddingTeamColorClass} text-white shadow hover:brightness-95` : `bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 dark:bg-gray-700 dark:border-gray-500 dark:text-white dark:hover:bg-gray-600`} ${focusRingColor}" onclick="handleBiddingPointsToggle(false)" aria-pressed="${nonBiddingTeamButtonActive}">${nonBiddingTeamName}</button>
        </div>
      </div>
      <div>
        <label for="pointsInput" class="block text-sm font-medium mb-1.5 text-gray-700 dark:text-white">${labelText}</label>
        <div class="flex flex-col sm:flex-row sm:items-center sm:gap-5">
          <input id="pointsInput" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="360" step="5" value="${ephemeralPoints}" oninput="ephemeralPoints = this.value" placeholder="Enter points" class="w-full sm:flex-grow border border-gray-300 rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 ${focusRingColor} transition dark:bg-gray-700 dark:border-gray-500 dark:text-white" />
          <button type="submit" class="mt-2 sm:mt-0 bg-blue-600 text-white px-4 py-1.5 text-sm rounded-xl shadow hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-blue-500 dark:hover:bg-blue-600 dark:focus:ring-blue-400 threed">Submit</button>
        </div>
      </div>
    </div>`;
}
function renderHistoryCard() {
  const { rounds, usTeamName, demTeamName } = state;
  const labelUs = usTeamName || "Us";
  const labelDem = demTeamName || "Dem";
  if (!rounds.length) return ""; // Don't render if no history

  // Check if we should show the probability dropdown button
  const showProbabilityButton = state.showWinProbability && !state.gameOver && rounds.length > 0;
  const currentTotals = getLastRunningTotals();
  const pointDiffRaw = currentTotals.us - currentTotals.dem;
  const pointDiffDisplay = pointDiffRaw > 0
    ? `${labelUs} +${pointDiffRaw}`
    : pointDiffRaw < 0
      ? `${labelDem} +${Math.abs(pointDiffRaw)}`
      : "Tied";
  const pointDiffColorClass = pointDiffRaw > 0
    ? "text-primary"
    : pointDiffRaw < 0
      ? "text-accent"
      : "text-gray-800 dark:text-white";

  return `
    <div class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow">
      <div class="border-b border-gray-200 p-4 dark:border-gray-700">
        <div class="flex items-start justify-between gap-3">
          <h2 class="text-lg font-bold text-gray-800 dark:text-white">History</h2>
          <p class="text-sm font-medium text-gray-600 dark:text-gray-300">
            Point Difference:
            <span class="font-semibold ${pointDiffColorClass}">${pointDiffDisplay}</span>
          </p>
        </div>
        <div class="grid grid-cols-3 gap-2 mt-3 font-medium text-gray-600 dark:text-white text-sm sm:text-base">
          <div class="text-left truncate">${labelUs}</div>
          <div class="text-center">Bid</div>
          <div class="text-right truncate">${labelDem}</div>
        </div>
      </div>
      <div class="p-4 max-h-60 overflow-y-auto no-scrollbar">
        <div class="space-y-2">
          ${rounds.map((round, idx) => {
            const biddingTeamLabel = round.biddingTeam === "us" ? (round.usTeamNameOnRound || labelUs) : (round.demTeamNameOnRound || labelDem);
            const arrow = round.biddingTeam === "us" ? `<span class="text-gray-800 dark:text-white">←</span><span class="ml-1 text-black dark:text-white">${round.bidAmount}</span>` : `<span class="mr-1 text-black dark:text-white">${round.bidAmount}</span><span class="text-gray-800 dark:text-white">→</span>`;
            const bidDetails = `${biddingTeamLabel} bid ${round.bidAmount}`;
            return `
              <div key="${idx}" class="grid grid-cols-3 gap-2 p-2 bg-gray-50 rounded-xl dark:bg-gray-700 text-sm">
                <div class="text-left text-gray-800 dark:text-white font-semibold">${round.runningTotals.us}</div>
                <div class="text-center text-gray-600 dark:text-gray-400">${arrow}</div>
                <div class="text-right text-gray-800 dark:text-white font-semibold">${round.runningTotals.dem}</div>
              </div>`;
          }).join("")}
        </div>
      </div>
      ${showProbabilityButton ? `
        <div class="border-t border-gray-200 dark:border-gray-700">
          <button onclick="openProbabilityModal()" 
                  class="w-full p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-b-xl">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-gray-700 dark:text-gray-300">How was this probability reached?</span>
              <svg class="w-4 h-4 text-gray-400 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
          </button>
        </div>
      ` : ''}
    </div>`;
}
function renderGameOverOverlay() {
  if (!state.gameOver) return "";
  const winnerLabel = state.winner === "us" ? (state.usTeamName || "Us") : (state.winner === "dem" ? (state.demTeamName || "Dem") : "It's a Tie");
  return `
<div data-overlay="gameover"
     class="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-md flex items-center justify-center p-4"
     style="z-index:49;"
     role="alertdialog" aria-labelledby="gameOverTitle" aria-modal="true">
      <div class="bg-white dark:bg-gray-800 w-full max-w-md rounded-xl shadow-lg text-center">
        <div class="p-6">
          <h2 id="gameOverTitle" class="text-3xl font-bold mb-2 animate-fadeIn text-gray-800 dark:text-white">Game Over!</h2>
          <p class="text-xl mb-1 animate-fadeIn text-gray-700 dark:text-white">${winnerLabel} Wins!</p>
          <p class="text-sm mb-6 animate-fadeIn text-gray-500 dark:text-gray-400">(${state.victoryMethod || 'Game Ended'})</p>
          <div class="flex space-x-4 justify-center">
            <button onclick="handleGameOverFixClick(event)" class="bg-gray-200 text-gray-800 px-6 py-3 rounded-xl shadow hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400 transition dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600 dark:focus:ring-gray-500 threed" type="button">Fix Score</button>
            <button onclick="handleGameOverSaveClick(event)" class="bg-green-600 text-white px-6 py-3 rounded-xl shadow hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 transition dark:bg-green-500 dark:hover:bg-green-600 dark:focus:ring-green-400 threed" type="button">Save Game</button>
            <button onclick="handleNewGame()" class="bg-blue-600 text-white px-6 py-3 rounded-xl shadow hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition dark:bg-blue-500 dark:hover:bg-blue-600 dark:focus:ring-blue-400 threed" type="button">New Game</button>
          </div>
        </div>
      </div>
    </div>`;
}
// (renderReadOnlyGameDetails, renderSavedGames, renderFreezerGames, renderStatisticsContent, renderTeamStatsTable - these remain substantial and are called by modal openers)
function renderReadOnlyGameDetails(game) {
  const { rounds, timestamp, usTeamName, demTeamName, durationMs, winner, finalScore, victoryMethod } = game;
  const usDisp = usTeamName || "Us", demDisp = demTeamName || "Dem";
  const usScore = finalScore && typeof finalScore.us === "number" ? finalScore.us : 0;
  const demScore = finalScore && typeof finalScore.dem === "number" ? finalScore.dem : 0;
  const usWinner = winner === "us", demWinner = winner === "dem";
  const dateStr = new Date(timestamp).toLocaleString([], { year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });

  // Determine sandbag for winner
  let sandbagResult = "N/A";
  if (winner === "us" || winner === "dem") {
    const winnerPlayers = winner === "us"
      ? canonicalizePlayers(game.usPlayers || parseLegacyTeamName(game.usTeamName || game.usName))
      : canonicalizePlayers(game.demPlayers || parseLegacyTeamName(game.demTeamName || game.demName));
    sandbagResult = isGameSandbagForTeamKey(game, winnerPlayers) ? "Yes" : "No";
  }

  const roundHtml = (rounds || []).map((r, idx) => {
      const bidTeam = r.biddingTeam === "us" ? (r.usTeamNameOnRound || usDisp) : (r.demTeamNameOnRound || demDisp);
      const arrow = r.biddingTeam === "us" ? "←" : "→";
      const bidDisplay = `${r.bidAmount} ${arrow}`;
      return `
      <div class="grid grid-cols-5 gap-1 p-2 bg-gray-50 rounded-xl dark:bg-gray-700 text-sm sm:text-base mb-2">
        <div class="text-left font-medium col-span-1 ${r.biddingTeam === "us" && r.usPoints < r.bidAmount ? 'text-red-500' : 'text-gray-800 dark:text-white'}">${r.runningTotals.us}</div>
        <div class="text-center text-gray-600 dark:text-gray-300 text-xs sm:text-sm col-span-3">
          <span class="bg-gray-200 dark:bg-gray-600 px-2 py-0.5 rounded-full">${bidTeam} bid ${bidDisplay}</span>
        </div>
        <div class="text-right font-medium col-span-1 ${r.biddingTeam === "dem" && r.demPoints < r.bidAmount ? 'text-red-500' : 'text-gray-800 dark:text-white'}">${r.runningTotals.dem}</div>
      </div>`;
  }).join("");

  return `
    <div class="space-y-4"> <!-- Reduced vertical spacing -->
      <div class="bg-gray-50 dark:bg-gray-700 rounded-xl p-3 shadow-sm"> <!-- Reduced padding -->
        <div class="flex flex-col sm:flex-row justify-between items-center mb-2"> <!-- Reduced margin -->
          <h4 class="text-xl font-bold text-gray-800 dark:text-white text-center sm:text-left">${usDisp} vs ${demDisp}</h4>
          <span class="bg-blue-100 text-blue-800 text-xs font-medium px-3 py-1 rounded-full dark:bg-blue-900 dark:text-blue-300">${dateStr}</span>
        </div>
        <div class="flex justify-around items-center text-center">
          <div class="${usWinner ? 'text-green-500 dark:text-green-400' : 'text-gray-800 dark:text-white'}">
            <div class="text-sm">${usDisp}</div><div class="text-2xl font-bold">${usScore}</div>
            ${usWinner ? '<div class="text-xs font-medium">WINNER</div>' : ''}
          </div>
          <div class="text-gray-400 dark:text-gray-500 text-lg">vs</div>
          <div class="${demWinner ? 'text-green-500 dark:text-green-400' : 'text-gray-800 dark:text-white'}">
            <div class="text-sm">${demDisp}</div><div class="text-2xl font-bold">${demScore}</div>
            ${demWinner ? '<div class="text-xs font-medium">WINNER</div>' : ''}
          </div>
        </div>
        ${victoryMethod ? `<p class="text-center text-xs text-gray-500 dark:text-gray-400 mt-1">(${victoryMethod})</p>` : ''}
      </div>
      <div class="flex flex-row gap-2 sm:gap-4 mb-1"> <!-- Side by side, tighter gap -->
        <div class="flex-1 bg-white dark:bg-gray-800 rounded-xl p-2 shadow-sm flex flex-col items-start"> <!-- Tighter padding -->
          <span class="text-xs font-semibold text-gray-800 dark:text-white">Sandbag?</span>
          <span class="text-sm text-gray-700 dark:text-gray-300">${sandbagResult}</span>
        </div>
        <div class="flex-1 bg-white dark:bg-gray-800 rounded-xl p-2 shadow-sm flex flex-col items-end"> <!-- Tighter padding -->
          <span class="text-xs font-semibold text-gray-800 dark:text-white">Duration</span>
          <span class="text-sm text-gray-700 dark:text-gray-300">${durationMs ? formatDuration(durationMs) : "N/A"}</span>
        </div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl p-3 shadow-sm"> <!-- Reduced padding -->
        <p class="font-semibold text-gray-800 dark:text-white mb-1">Round History</p>
        <div class="space-y-2 max-h-60 overflow-y-auto rounded-xl pr-1 no-scrollbar">${roundHtml || '<p class="text-gray-500">No rounds.</p>'}</div>
      </div>
      <div class="flex justify-center"><button type="button" onclick="closeViewSavedGameModal()" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-xl font-medium focus:outline-none focus:ring-2 focus:ring-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white transition-colors threed">Close</button></div>
    </div>`;
}
// --- Saved Games Modal (New Functions) ---
function switchGamesTab(tabType) {
  const completedTab = document.getElementById('completedGamesTab');
  const freezerTab = document.getElementById('freezerGamesTab');
  const completedSection = document.getElementById('completedGamesSection');
  const freezerSection = document.getElementById('freezerGamesSection');

  const activeClasses = ['border-blue-600', 'text-blue-600', 'dark:text-blue-400', 'dark:border-blue-400'];
  const inactiveClasses = ['border-transparent', 'text-gray-500', 'hover:text-gray-700', 'dark:text-gray-400', 'dark:hover:text-gray-300'];

  if (tabType === 'completed') {
      completedTab.classList.add(...activeClasses); completedTab.classList.remove(...inactiveClasses);
      freezerTab.classList.add(...inactiveClasses); freezerTab.classList.remove(...activeClasses);
      completedSection.classList.remove('hidden'); freezerSection.classList.add('hidden');
  } else {
      freezerTab.classList.add(...activeClasses); freezerTab.classList.remove(...inactiveClasses);
      completedTab.classList.add(...inactiveClasses); completedTab.classList.remove(...activeClasses);
      freezerSection.classList.remove('hidden'); completedSection.classList.add('hidden');
  }
  document.getElementById('gameSearchInput').value = '';
  document.getElementById('gameSortSelect').value = 'newest';
  renderGamesWithFilter();
}
function updateGamesCount() {
  const savedGames = getLocalStorage("savedGames", []);
  const freezerGames = getLocalStorage("freezerGames", []);
  document.getElementById('completedGamesCount').textContent = savedGames.length;
  document.getElementById('freezerGamesCount').textContent = freezerGames.length;
  document.getElementById('noCompletedGamesMessage').classList.toggle('hidden', savedGames.length > 0);
  document.getElementById('noFreezerGamesMessage').classList.toggle('hidden', freezerGames.length > 0);
}
function filterGames() { renderGamesWithFilter(); }
function sortGames() { renderGamesWithFilter(); }
function renderGamesWithFilter() {
  const rawSearchValue = document.getElementById('gameSearchInput').value || '';
  const searchTerm = rawSearchValue.trim().toLowerCase();
  const displaySearch = rawSearchValue.trim();
  const sortOption = document.getElementById('gameSortSelect').value;
  const completedTabActive = !document.getElementById('completedGamesSection').classList.contains('hidden');

  if (completedTabActive) {
    renderGamesList({
      storageKey: 'savedGames',
      containerId: 'savedGamesList',
      emptyMessageId: 'noCompletedGamesMessage',
      emptySearchMessage: 'No completed games match',
      searchTerm,
      displaySearch,
      sortOption,
      buildCard: buildSavedGameCard,
    });
  } else {
    renderGamesList({
      storageKey: 'freezerGames',
      containerId: 'freezerGamesList',
      emptyMessageId: 'noFreezerGamesMessage',
      emptySearchMessage: 'No frozen games match',
      searchTerm,
      displaySearch,
      sortOption,
      buildCard: buildFreezerGameCard,
    });
  }
}

function renderGamesList({ storageKey, containerId, emptyMessageId, emptySearchMessage, searchTerm, displaySearch, sortOption, buildCard }) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const entries = getLocalStorage(storageKey, []).map((game, index) => ({ game, index }));
  const normalizedTerm = searchTerm || '';

  const filteredEntries = normalizedTerm
    ? entries.filter(({ game }) => {
        const us = getGameTeamDisplay(game, 'us').toLowerCase();
        const dem = getGameTeamDisplay(game, 'dem').toLowerCase();
        const timestamp = game.timestamp ? new Date(game.timestamp).toLocaleString().toLowerCase() : '';
        return us.includes(normalizedTerm) || dem.includes(normalizedTerm) || timestamp.includes(normalizedTerm);
      })
    : entries;

  const sortedEntries = sortGamesBy(filteredEntries, sortOption);
  const listHtml = sortedEntries.map(({ game, index }) => buildCard(game, index)).join('');

  const emptyMessageEl = document.getElementById(emptyMessageId);
  if (emptyMessageEl) emptyMessageEl.classList.toggle('hidden', sortedEntries.length > 0);

  container.innerHTML = listHtml || (!normalizedTerm ? '' : `<p class="text-gray-500 col-span-full text-center">${emptySearchMessage} "${displaySearch}".</p>`);
}

function buildSavedGameCard(game, originalIndex) {
  const usDisplay = getGameTeamDisplay(game, 'us');
  const demDisplay = getGameTeamDisplay(game, 'dem');
  const usScore = game.finalScore && typeof game.finalScore.us === "number" ? game.finalScore.us : 0;
  const demScore = game.finalScore && typeof game.finalScore.dem === "number" ? game.finalScore.dem : 0;
  const usWon = game.winner === 'us';
  const demWon = game.winner === 'dem';
  const timestamp = game.timestamp ? new Date(game.timestamp).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown date';

  return `
    <div class="bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-lg transition-shadow dark:bg-gray-800 dark:border-gray-700 cursor-pointer relative" onclick="viewSavedGame(${originalIndex})">
      ${usWon ? `<div class="absolute top-0 right-2 bg-green-100 text-green-800 text-xs font-semibold px-2 py-0.5 rounded-full dark:bg-green-900 dark:text-green-300">Winner: ${usDisplay}</div>` : ''}
      ${demWon ? `<div class="absolute top-0 right-2 bg-green-100 text-green-800 text-xs font-semibold px-2 py-0.5 rounded-full dark:bg-green-900 dark:text-green-300">Winner: ${demDisplay}</div>` : ''}
      <div class="p-5">
        <div class="flex justify-between items-start mb-2">
          <div>
            <h3 class="text-lg font-semibold text-gray-900 dark:text-white">${usDisplay} vs ${demDisplay}</h3>
            <div class="text-sm text-gray-500 dark:text-gray-400">${timestamp}</div>
          </div>
          <div class="flex space-x-1">
            <button onclick="viewSavedGame(${originalIndex}); event.stopPropagation();" class="p-1.5 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-300" aria-label="View"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg></button>
            <button onclick="deleteSavedGame(${originalIndex}); event.stopPropagation();" class="p-1.5 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 rounded-full focus:outline-none focus:ring-2 focus:ring-red-300" aria-label="Delete">${Icons.Trash}</button>
          </div>
        </div>
        <div class="text-sm">
          <span class="${usWon ? 'text-green-600 font-bold' : 'text-gray-700 dark:text-gray-300'}">${usDisplay}: ${usScore}</span> |
          <span class="${demWon ? 'text-green-600 font-bold' : 'text-gray-700 dark:text-gray-300'}">${demDisplay}: ${demScore}</span>
        </div>
        <div class="mt-2 flex items-center space-x-2 text-xs text-gray-500 dark:text-gray-400">
          ${game.victoryMethod ? `<span class="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full dark:bg-purple-900 dark:text-purple-300">${game.victoryMethod}</span>` : ''}
          ${game.durationMs ? `<span>${formatDuration(game.durationMs)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function buildFreezerGameCard(game, originalIndex) {
  const usDisplay = getGameTeamDisplay(game, 'us');
  const demDisplay = getGameTeamDisplay(game, 'dem');
  const usScore = game.finalScore && typeof game.finalScore.us === "number" ? game.finalScore.us : 0;
  const demScore = game.finalScore && typeof game.finalScore.dem === "number" ? game.finalScore.dem : 0;
  const timestamp = game.timestamp ? new Date(game.timestamp).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown date';
  const leadInfo = usScore > demScore
    ? `${usDisplay} leads by ${usScore - demScore}`
    : demScore > usScore
      ? `${demDisplay} leads by ${demScore - usScore}`
      : 'Tied';

  return `
    <div class="bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-lg transition-shadow dark:bg-gray-800 dark:border-gray-700 cursor-pointer relative" onclick="loadFreezerGame(${originalIndex})">
      <div class="absolute top-0 right-2 bg-yellow-100 text-yellow-800 text-xs font-semibold px-2 py-0.5 rounded-full dark:bg-yellow-900 dark:text-yellow-300">${leadInfo}</div>
      <div class="p-5">
        <div class="flex justify-between items-start mb-2">
          <div>
            <h3 class="text-lg font-semibold text-gray-900 dark:text-white">${usDisplay} vs ${demDisplay}</h3>
            <div class="text-sm text-gray-500 dark:text-gray-400">Frozen: ${timestamp}</div>
          </div>
          <div class="flex space-x-1">
            <button onclick="loadFreezerGame(${originalIndex}); event.stopPropagation();" class="p-1.5 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-300" aria-label="Load">${Icons.Load}</button>
            <button onclick="deleteFreezerGame(${originalIndex}); event.stopPropagation();" class="p-1.5 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 rounded-full focus:outline-none focus:ring-2 focus:ring-red-300" aria-label="Delete">${Icons.Trash}</button>
          </div>
        </div>
        <div class="text-sm text-gray-700 dark:text-gray-300">
          <span>${usDisplay}: ${usScore}</span> | <span>${demDisplay}: ${demScore}</span>
        </div>
        <div class="mt-2 flex items-center space-x-2 text-xs text-gray-500 dark:text-gray-400">
          ${game.lastBid ? `<span class="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full dark:bg-indigo-900 dark:text-indigo-300">Last Bid: ${game.lastBid}</span>` : ''}
          ${game.accumulatedTime ? `<span>Played: ${formatDuration(game.accumulatedTime)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function sortGamesBy(entries, sortOption = 'newest') {
  const sorted = [...entries];
  const getTimestamp = ({ game }) => {
    const parsed = game.timestamp ? Date.parse(game.timestamp) : NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const getHighScore = ({ game }) => {
    const finalScore = game.finalScore || {};
    const usScore = Number(finalScore.us) || 0;
    const demScore = Number(finalScore.dem) || 0;
    return Math.max(usScore, demScore);
  };

  switch (sortOption) {
    case 'oldest':
      sorted.sort((a, b) => getTimestamp(a) - getTimestamp(b));
      break;
    case 'highest':
      sorted.sort((a, b) => getHighScore(b) - getHighScore(a));
      break;
    case 'lowest':
      sorted.sort((a, b) => getHighScore(a) - getHighScore(b));
      break;
    case 'newest':
    default:
      sorted.sort((a, b) => getTimestamp(b) - getTimestamp(a));
      break;
  }
  return sorted;
}
// --- Statistics Modal Rendering ---
function renderStatisticsContent() {
  const stats = getStatistics();
  let content = "";
  if (!stats.totalGames && !stats.teamsData.length) {
      content = `<div class="py-8 text-center"><svg xmlns="http://www.w3.org/2000/svg" class="h-14 w-14 mx-auto text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg><p class="mt-4 text-gray-600 dark:text-gray-400 text-lg">No stats yet. Play some games!</p><button onclick="handleNewGame(); closeMenuOverlay(); closeStatisticsModal();" class="mt-6 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shadow-sm">Start New Game</button></div>`;
  } else {
      const statCard = (title, value, iconSvg, color) => `
          <div class="bg-gradient-to-br from-${color}-50 to-${color}-100 dark:from-gray-700 dark:to-gray-800 rounded-lg p-2.5 shadow-sm">
            <div class="flex items-center"><div class="p-1.5 bg-${color}-500 rounded-lg text-white">${iconSvg}</div>
              <div class="ml-2"><p class="text-xs uppercase font-semibold text-gray-500 dark:text-gray-400">${title}</p><p class="text-lg font-bold text-gray-900 dark:text-white">${value}</p></div>
            </div></div>`;

      const icons = {
          avgBid: '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>',
          timePlayed: '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>',
          gamesPlayed: '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>'
      };
      let statCardsHtml = stats.totalGames > 0 ? `<div class="sticky bottom-0 z-30 -mx-4 sm:mx-0 pt-4 pb-5 mt-4 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
          <div class="grid grid-cols-3 gap-2">
            ${statCard("Avg Bid", stats.overallAverageBid, icons.avgBid, "blue")}
            ${statCard("Time Played", formatDuration(stats.totalTimePlayedMs), icons.timePlayed, "purple")}
            ${statCard("Games Played", stats.totalGames, icons.gamesPlayed, "green")}
          </div>
      </div>` : "";
      const viewSelector = `<div class="mb-4"><label for="statsViewModeSelect" class="block text-sm font-medium text-gray-700 dark:text-white mb-2">Show statistics for</label><div class="relative"><select id="statsViewModeSelect" class="appearance-none block w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg py-2.5 px-3 text-gray-700 dark:text-white leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:focus:ring-blue-400"><option value="teams"${statsViewMode === 'teams' ? ' selected' : ''}>Teams</option><option value="players"${statsViewMode === 'players' ? ' selected' : ''}>Individuals</option></select><div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-700 dark:text-gray-300"><svg class="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg></div></div></div>`;

      const metricOptions = ['games', 'avgBid', 'bidSuccessPct', 'sandbagger', '360s']
        .map(opt => `<option value="${opt}"${statsMetricKey === opt ? ' selected' : ''}>${opt === 'games' ? 'Games Played' : opt === 'avgBid' ? 'Avg Bid' : opt === 'bidSuccessPct' ? 'Bid Success %' : opt === 'sandbagger' ? 'Sandbagger?' : '360s'}</option>`)
        .join('');
      const metricLabel = statsViewMode === 'teams' ? 'Team statistic' : 'Individual statistic';
      const statSelector = `<div class="mb-4"><label for="additionalStatSelector" class="block text-sm font-medium text-gray-700 dark:text-white mb-2">${metricLabel}</label><div class="relative"><select id="additionalStatSelector" class="appearance-none block w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg py-2.5 px-3 text-gray-700 dark:text-white leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:focus:ring-blue-400">${metricOptions}</select><div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-700 dark:text-gray-300"><svg class="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg></div></div></div>`;

      const statsDataForMode = statsViewMode === 'teams' ? stats.teamsData : stats.playersData;
      const statsTableHtml = renderStatsTable(statsViewMode, statsDataForMode, statsMetricKey);
      const controlsBlock = `<div class="stats-controls bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">${viewSelector}${statSelector}</div>`;
      content = `${controlsBlock}<div id="teamStatsTableWrapper" class="pb-28">${statsTableHtml}</div>${statCardsHtml}`;
  }
  document.getElementById("statisticsModalContent").innerHTML = content;
  const viewModeSelect = document.getElementById('statsViewModeSelect');
  if (viewModeSelect) {
    viewModeSelect.value = statsViewMode;
    viewModeSelect.addEventListener('change', e => {
      statsViewMode = e.target.value === 'players' ? 'players' : 'teams';
      renderStatisticsContent();
    });
  }
  const selector = document.getElementById("additionalStatSelector");
  if (selector) {
      selector.value = statsMetricKey;
      selector.addEventListener("change", function () {
          statsMetricKey = this.value;
          const latestStats = getStatistics();
          const data = statsViewMode === 'players' ? latestStats.playersData : latestStats.teamsData;
          document.getElementById("teamStatsTableWrapper").innerHTML = renderStatsTable(statsViewMode, data, statsMetricKey);
      });
  }
}
function getStatistics() {
  const savedGames = getLocalStorage("savedGames", []).filter(g => g && Array.isArray(g.rounds) && g.rounds.length > 0);

  const teamStatsMap = new Map();
  const playerStatsMap = new Map();
  let totalBids = 0;
  let sumOfBids = 0;
  let totalGameDuration = 0;

  const ensureTeamRecord = (key, players, displayName, timestampMs) => {
    if (!key) return null;
    if (!teamStatsMap.has(key)) {
      teamStatsMap.set(key, {
        key,
        name: displayName,
        players,
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        totalBidAmount: 0,
        bidsMade: 0,
        bidsSucceeded: 0,
        handsPlayed: 0,
        handsWon: 0,
        sandbagGames: 0,
        perfect360s: 0,
        lastPlayed: 0,
        totalTimeMs: 0,
      });
    }
    const record = teamStatsMap.get(key);
    if (timestampMs && timestampMs > record.lastPlayed) record.lastPlayed = timestampMs;
    if (!record.name) record.name = displayName;
    record.players = canonicalizePlayers(record.players.length ? record.players : players);
    return record;
  };

  const ensurePlayerRecord = (name, timestampMs) => {
    const cleanName = sanitizePlayerName(name);
    if (!cleanName) return null;
    const key = cleanName.toLowerCase();
    if (!playerStatsMap.has(key)) {
      playerStatsMap.set(key, {
        key,
        name: cleanName,
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        totalBidAmount: 0,
        bidsMade: 0,
        bidsSucceeded: 0,
        handsPlayed: 0,
        handsWon: 0,
        sandbagGames: 0,
        perfect360s: 0,
        lastPlayed: 0,
        totalTimeMs: 0,
      });
    }
    const record = playerStatsMap.get(key);
    if (timestampMs && timestampMs > record.lastPlayed) record.lastPlayed = timestampMs;
    return record;
  };

  savedGames.forEach(game => {
    const gameDuration = Number(game.durationMs) || 0;
    totalGameDuration += gameDuration;
    const timestampMs = new Date(game.timestamp || Date.now()).getTime();

    const usPlayers = canonicalizePlayers(game.usPlayers || parseLegacyTeamName(game.usTeamName || game.usName));
    const demPlayers = canonicalizePlayers(game.demPlayers || parseLegacyTeamName(game.demTeamName || game.demName));
    const usKey = buildTeamKey(usPlayers);
    const demKey = buildTeamKey(demPlayers);
    const usDisplay = deriveTeamDisplay(usPlayers, game.usTeamName || game.usName || 'Us') || 'Us';
    const demDisplay = deriveTeamDisplay(demPlayers, game.demTeamName || game.demName || 'Dem') || 'Dem';

    const usTeam = ensureTeamRecord(usKey, usPlayers, usDisplay, timestampMs);
    const demTeam = ensureTeamRecord(demKey, demPlayers, demDisplay, timestampMs);

    const usPlayerRecords = usPlayers.filter(Boolean).map(name => ensurePlayerRecord(name, timestampMs)).filter(Boolean);
    const demPlayerRecords = demPlayers.filter(Boolean).map(name => ensurePlayerRecord(name, timestampMs)).filter(Boolean);

    if (usTeam) {
      usTeam.gamesPlayed++;
      usTeam.totalTimeMs += gameDuration;
    }
    if (demTeam) {
      demTeam.gamesPlayed++;
      demTeam.totalTimeMs += gameDuration;
    }
    usPlayerRecords.forEach(rec => {
      rec.gamesPlayed++;
      rec.totalTimeMs += gameDuration;
    });
    demPlayerRecords.forEach(rec => {
      rec.gamesPlayed++;
      rec.totalTimeMs += gameDuration;
    });

    if (game.winner === 'us') {
      if (usTeam) usTeam.wins++;
      if (demTeam) demTeam.losses++;
      usPlayerRecords.forEach(rec => rec.wins++);
      demPlayerRecords.forEach(rec => rec.losses++);
    } else if (game.winner === 'dem') {
      if (demTeam) demTeam.wins++;
      if (usTeam) usTeam.losses++;
      demPlayerRecords.forEach(rec => rec.wins++);
      usPlayerRecords.forEach(rec => rec.losses++);
    }

    game.rounds.forEach(round => {
      const bidAmount = Number(round.bidAmount) || 0;
      if (bidAmount) {
        sumOfBids += bidAmount;
        totalBids++;
      }

      const usPoints = Number(round.usPoints) || 0;
      const demPoints = Number(round.demPoints) || 0;

      if (usTeam) usTeam.handsPlayed++;
      if (demTeam) demTeam.handsPlayed++;
      usPlayerRecords.forEach(rec => rec.handsPlayed++);
      demPlayerRecords.forEach(rec => rec.handsPlayed++);

      if (usPoints > demPoints) {
        if (usTeam) usTeam.handsWon++;
        usPlayerRecords.forEach(rec => rec.handsWon++);
      } else if (demPoints > usPoints) {
        if (demTeam) demTeam.handsWon++;
        demPlayerRecords.forEach(rec => rec.handsWon++);
      }

      if (usPoints === 360) {
        if (usTeam) usTeam.perfect360s++;
        usPlayerRecords.forEach(rec => rec.perfect360s++);
      }
      if (demPoints === 360) {
        if (demTeam) demTeam.perfect360s++;
        demPlayerRecords.forEach(rec => rec.perfect360s++);
      }

      if (round.biddingTeam === 'us') {
        if (usTeam) {
          usTeam.bidsMade++;
          usTeam.totalBidAmount += bidAmount;
          if (usPoints >= bidAmount) usTeam.bidsSucceeded++;
        }
        usPlayerRecords.forEach(rec => {
          rec.bidsMade++;
          rec.totalBidAmount += bidAmount;
          if (usPoints >= bidAmount) rec.bidsSucceeded++;
        });
      } else if (round.biddingTeam === 'dem') {
        if (demTeam) {
          demTeam.bidsMade++;
          demTeam.totalBidAmount += bidAmount;
          if (demPoints >= bidAmount) demTeam.bidsSucceeded++;
        }
        demPlayerRecords.forEach(rec => {
          rec.bidsMade++;
          rec.totalBidAmount += bidAmount;
          if (demPoints >= bidAmount) rec.bidsSucceeded++;
        });
      }
    });

    const sandbagUs = isGameSandbagForTeamKey(game, usPlayers);
    const sandbagDem = isGameSandbagForTeamKey(game, demPlayers);
    if (sandbagUs) {
      if (usTeam) usTeam.sandbagGames++;
      usPlayerRecords.forEach(rec => rec.sandbagGames++);
    }
    if (sandbagDem) {
      if (demTeam) demTeam.sandbagGames++;
      demPlayerRecords.forEach(rec => rec.sandbagGames++);
    }
  });

  const teamsData = Array.from(teamStatsMap.values()).map(team => {
    const winPercent = team.gamesPlayed ? ((team.wins / team.gamesPlayed) * 100).toFixed(1) : '0.0';
    const avgBid = team.bidsMade ? (team.totalBidAmount / team.bidsMade).toFixed(0) : 'N/A';
    const bidSuccessPct = team.bidsMade ? ((team.bidsSucceeded / team.bidsMade) * 100).toFixed(1) : 'N/A';
    const sandbagger = team.gamesPlayed && (team.sandbagGames / team.gamesPlayed > 0.5) ? 'Yes' : 'No';
    return {
      ...team,
      winPercent,
      avgBid,
      bidSuccessPct,
      sandbagger,
      count360: team.perfect360s,
    };
  }).sort((a, b) => b.lastPlayed - a.lastPlayed);

  const playersData = Array.from(playerStatsMap.values()).map(player => {
    const winPercent = player.gamesPlayed ? ((player.wins / player.gamesPlayed) * 100).toFixed(1) : '0.0';
    const avgBid = player.bidsMade ? (player.totalBidAmount / player.bidsMade).toFixed(0) : 'N/A';
    const bidSuccessPct = player.bidsMade ? ((player.bidsSucceeded / player.bidsMade) * 100).toFixed(1) : 'N/A';
    const sandbagger = player.gamesPlayed && (player.sandbagGames / player.gamesPlayed > 0.5) ? 'Yes' : 'No';
    return {
      ...player,
      winPercent,
      avgBid,
      bidSuccessPct,
      sandbagger,
      count360: player.perfect360s,
    };
  }).sort((a, b) => b.lastPlayed - a.lastPlayed);

  return {
    totalGames: savedGames.length,
    overallAverageBid: totalBids > 0 ? (sumOfBids / totalBids).toFixed(0) : 'N/A',
    teamsData,
    playersData,
    totalTimePlayedMs: totalGameDuration,
  };
}

function isGameSandbagForTeamKey(game, teamPlayers, threshold = 2) {
  const teamKey = buildTeamKey(teamPlayers);
  if (!teamKey) return false;

  const gameUsKey = buildTeamKey(canonicalizePlayers(game.usPlayers || parseLegacyTeamName(game.usTeamName || game.usName)));
  const gameDemKey = buildTeamKey(canonicalizePlayers(game.demPlayers || parseLegacyTeamName(game.demTeamName || game.demName)));

  let target = null;
  let opponent = null;
  if (teamKey === gameUsKey) {
    target = 'us';
    opponent = 'dem';
  } else if (teamKey === gameDemKey) {
    target = 'dem';
    opponent = 'us';
  } else {
    return false;
  }

  let sandbagOpportunities = 0;
  (game.rounds || []).forEach(round => {
    if (round.biddingTeam === opponent && Number(round[`${opponent}Points`]) < 0) {
      const targetPoints = Number(round[`${target}Points`]) || 0;
      const bidAmount = Number(round.bidAmount) || 0;
      if (targetPoints >= 80 || targetPoints >= bidAmount) sandbagOpportunities++;
    }
  });
  return sandbagOpportunities >= threshold;
}
function renderStatsTable(mode, statsData, additionalStatKey) {
  const headers = { games: "Games", avgBid: "Avg Bid", bidSuccessPct: "Bid Success %", sandbagger: "Sandbagger?", "360s": "360s" };
  const nameHeader = mode === 'teams' ? 'Team' : 'Player';
  if (!statsData || !statsData.length) {
    const emptyLabel = mode === 'teams' ? 'No team stats yet.' : 'No individual stats yet.';
    return `<p class="text-center text-gray-500 dark:text-gray-400 mt-4">${emptyLabel}</p>`;
  }

  let tableHTML = `<div id="teamStatsTableContainer" class="mt-4"><div class="overflow-x-auto -mx-4 sm:mx-0"><div class="inline-block min-w-full align-middle"><table class="min-w-full divide-y divide-gray-200 dark:divide-gray-600"><thead><tr>
      <th scope="col" class="py-3 pl-4 pr-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 sticky left-0 z-10">${nameHeader}</th>
      <th scope="col" class="px-3 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700">Win %</th>
      <th scope="col" class="px-3 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700">${headers[additionalStatKey] || 'Stat'}</th>`;
  if (mode === 'teams') {
    tableHTML += `<th scope="col" class="pl-3 pr-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700">Del</th>`;
  }
  tableHTML += `</tr></thead><tbody class="divide-y divide-gray-200 dark:divide-gray-600 bg-white dark:bg-gray-800">`;

  statsData.forEach((item, index) => {
    const rowClass = index % 2 === 0 ? "bg-white dark:bg-gray-800" : "bg-gray-50 dark:bg-gray-700";
    const lookup = {
      games: item.gamesPlayed,
      '360s': item.count360,
      avgBid: item.avgBid,
      bidSuccessPct: item.bidSuccessPct,
      sandbagger: item.sandbagger,
    };
    let statVal = lookup[additionalStatKey];
    if (statVal === undefined || statVal === null) statVal = '0';
    if (additionalStatKey.includes('Pct') && typeof statVal === 'string' && !statVal.includes('%') && statVal !== 'N/A') statVal += '%';

    const displayName = mode === 'teams' ? item.name : item.name;
    tableHTML += `<tr class="${rowClass}">
      <td class="whitespace-nowrap py-3.5 pl-4 pr-3 text-sm font-medium text-gray-900 dark:text-white sticky left-0 z-10 ${rowClass}">${displayName}</td>
      <td class="whitespace-nowrap px-3 py-3.5 text-sm text-center text-gray-700 dark:text-gray-300">${item.winPercent}%</td>
      <td class="whitespace-nowrap px-3 py-3.5 text-sm text-center text-gray-700 dark:text-gray-300">${statVal}</td>`;
    if (mode === 'teams') {
      const escapedName = displayName.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      tableHTML += `<td class="whitespace-nowrap pl-3 pr-4 py-3.5 text-sm text-center"><button onclick="handleDeleteTeam('${item.key}', '${escapedName}'); event.stopPropagation();" class="text-red-600 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 rounded-full p-1.5 dark:text-red-400 dark:hover:text-red-300" aria-label="Delete Team">${Icons.Trash}</button></td>`;
    }
    tableHTML += `</tr>`;
  });

  tableHTML += `</tbody></table></div></div></div>`;
  return tableHTML;
}
function handleDeleteTeam(teamKey, displayName = '') {
  const fallbackLabel = displayName || 'this team';
  openConfirmationModal(`Delete team "${fallbackLabel}" and all related game data? This is irreversible.`, () => {
      const teams = getTeamsObject();
      let keyToDelete = teamKey && teams[teamKey] ? teamKey : null;
      if (!keyToDelete && displayName) {
        Object.entries(teams).forEach(([key, value]) => {
          const display = deriveTeamDisplay(value.players, value.displayName || '');
          if (!keyToDelete && display === displayName) keyToDelete = key;
        });
      }
      if (keyToDelete) {
        delete teams[keyToDelete];
        setTeamsObject(teams);
      }

      let savedGames = getLocalStorage("savedGames");
      savedGames = savedGames.filter(g => {
        const sameKey = (g.usTeamKey && g.usTeamKey === keyToDelete) || (g.demTeamKey && g.demTeamKey === keyToDelete);
        if (sameKey) return false;
        if (!displayName) return true;
        const usDisplay = getGameTeamDisplay(g, 'us');
        const demDisplay = getGameTeamDisplay(g, 'dem');
        return usDisplay !== displayName && demDisplay !== displayName;
      });
      setLocalStorage("savedGames", savedGames);

      let freezerGames = getLocalStorage("freezerGames");
      freezerGames = freezerGames.filter(g => {
        const sameKey = (g.usTeamKey && g.usTeamKey === keyToDelete) || (g.demTeamKey && g.demTeamKey === keyToDelete);
        if (sameKey) return false;
        if (!displayName) return true;
        const usDisplay = getGameTeamDisplay(g, 'us');
        const demDisplay = getGameTeamDisplay(g, 'dem');
        return usDisplay !== displayName && demDisplay !== displayName;
      });
      setLocalStorage("freezerGames", freezerGames);

      recalcTeamsStats();

      closeConfirmationModal();
      renderStatisticsContent(); // Refresh stats modal
  }, closeConfirmationModal);
}

// --- Settings Loading ---
function loadSettings() {
  console.log("Loading settings from localStorage...");

  // Load table talk penalty settings
  const penaltySelect = document.getElementById("tableTalkPenaltySelect");
  if (penaltySelect) {
    const savedPenaltyType = getLocalStorage(TABLE_TALK_PENALTY_TYPE_KEY, "setPoints");
    console.log("Loading Table Talk Penalty Type:", savedPenaltyType);
    penaltySelect.value = savedPenaltyType;
  } else {
    console.warn("tableTalkPenaltySelect element not found");
  }

  const penaltyPointsInput = document.getElementById("penaltyPointsInput");
  if (penaltyPointsInput) {
    const savedPenaltyPoints = getLocalStorage(TABLE_TALK_PENALTY_POINTS_KEY, "180");
    console.log("Loading Table Talk Penalty Points:", savedPenaltyPoints);
    penaltyPointsInput.value = savedPenaltyPoints;
  } else {
    console.warn("penaltyPointsInput element not found");
  }

  // Show/hide custom points input based on penalty type
  handleTableTalkPenaltyChange();

  console.log("Settings loading completed");
}

function migrateTeamsCollection() {
  const raw = getLocalStorage("teams") || {};
  const { data, changed } = normalizeTeamsStorage(raw);
  if (changed || raw.__storageVersion !== TEAM_STORAGE_VERSION) {
    setTeamsObject(data);
  }
}

function migrateSavedGamesTeamData() {
  const savedGames = getLocalStorage("savedGames", []);
  if (!Array.isArray(savedGames) || !savedGames.length) return;
  let changed = false;
  const migrated = savedGames.map(game => {
    if (!game || typeof game !== 'object') return game;
    const usPlayers = canonicalizePlayers(game.usPlayers || parseLegacyTeamName(game.usTeamName || game.usName));
    const demPlayers = canonicalizePlayers(game.demPlayers || parseLegacyTeamName(game.demTeamName || game.demName));
    const usDisplay = deriveTeamDisplay(usPlayers, game.usTeamName || game.usName || 'Us') || 'Us';
    const demDisplay = deriveTeamDisplay(demPlayers, game.demTeamName || game.demName || 'Dem') || 'Dem';
    const usTeamKey = buildTeamKey(usPlayers) || null;
    const demTeamKey = buildTeamKey(demPlayers) || null;

    if (!playersEqual(game.usPlayers, usPlayers) || !playersEqual(game.demPlayers, demPlayers) ||
        (game.usTeamName || '') !== usDisplay || (game.demTeamName || '') !== demDisplay ||
        (game.usTeamKey || null) !== usTeamKey || (game.demTeamKey || null) !== demTeamKey) {
      changed = true;
    }

    return {
      ...game,
      usPlayers,
      demPlayers,
      usTeamName: usDisplay,
      demTeamName: demDisplay,
      usTeamKey,
      demTeamKey,
    };
  });
  if (changed) setLocalStorage("savedGames", migrated);
}

function migrateFreezerGamesTeamData() {
  const freezerGames = getLocalStorage("freezerGames", []);
  if (!Array.isArray(freezerGames) || !freezerGames.length) return;
  let changed = false;
  const migrated = freezerGames.map(game => {
    if (!game || typeof game !== 'object') return game;
    const usPlayers = canonicalizePlayers(game.usPlayers || parseLegacyTeamName(game.usName));
    const demPlayers = canonicalizePlayers(game.demPlayers || parseLegacyTeamName(game.demName));
    const usDisplay = deriveTeamDisplay(usPlayers, game.usName || 'Us') || 'Us';
    const demDisplay = deriveTeamDisplay(demPlayers, game.demName || 'Dem') || 'Dem';
    const usTeamKey = buildTeamKey(usPlayers) || null;
    const demTeamKey = buildTeamKey(demPlayers) || null;

    if (!playersEqual(game.usPlayers, usPlayers) || !playersEqual(game.demPlayers, demPlayers) ||
        (game.usName || '') !== usDisplay || (game.demName || '') !== demDisplay ||
        (game.usTeamKey || null) !== usTeamKey || (game.demTeamKey || null) !== demTeamKey) {
      changed = true;
    }

    return {
      ...game,
      usPlayers,
      demPlayers,
      usName: usDisplay,
      demName: demDisplay,
      usTeamKey,
      demTeamKey,
    };
  });
  if (changed) setLocalStorage("freezerGames", migrated);
}

function migrateActiveGameStateTeams() {
  let rawState = null;
  try {
    const stored = localStorage.getItem(ACTIVE_GAME_KEY);
    if (stored) rawState = JSON.parse(stored);
  } catch (err) {
    console.warn('Active game state migration skipped due to parse error.', err);
    return;
  }
  if (!rawState || typeof rawState !== 'object') return;

  const usPlayers = canonicalizePlayers(rawState.usPlayers || parseLegacyTeamName(rawState.usTeamName));
  const demPlayers = canonicalizePlayers(rawState.demPlayers || parseLegacyTeamName(rawState.demTeamName));
  const usDisplay = deriveTeamDisplay(usPlayers, rawState.usTeamName || 'Us') || 'Us';
  const demDisplay = deriveTeamDisplay(demPlayers, rawState.demTeamName || 'Dem') || 'Dem';

  if (playersEqual(rawState.usPlayers, usPlayers) && playersEqual(rawState.demPlayers, demPlayers) &&
      (rawState.usTeamName || 'Us') === usDisplay && (rawState.demTeamName || 'Dem') === demDisplay) {
    return;
  }

  const updatedState = {
    ...rawState,
    usPlayers,
    demPlayers,
    usTeamName: usDisplay,
    demTeamName: demDisplay,
  };
  setLocalStorage(ACTIVE_GAME_KEY, updatedState);
}

function performTeamPlayerMigration() {
  try {
    migrateTeamsCollection();
    migrateSavedGamesTeamData();
    migrateFreezerGamesTeamData();
    migrateActiveGameStateTeams();
  } catch (err) {
    console.error('Team/player migration encountered an issue:', err);
  }
}

const globalBindings = {
  toggleMenu,
  closeMenuOverlay,
  openSavedGamesModal,
  closeSavedGamesModal,
  handleNewGame,
  handleFreezerGame,
  openSettingsModal,
  closeSettingsModal,
  openAboutModal,
  closeAboutModal,
  openStatisticsModal,
  closeStatisticsModal,
  showVersionNum,
  switchGamesTab,
  filterGames,
  sortGames,
  handleBugReportClick,
  handleTeamSelectionCancel,
  openThemeModal,
  closeThemeModal,
  randomizeThemeColors,
  applyCustomThemeColors,
  resetThemeColors,
  updatePreview,
  initializeCustomThemeColors,
  openPresetEditorModal,
  closePresetEditorModal,
  validatePresetInput,
  addPreset,
  removePreset,
  savePresets,
  applyTableTalkPenalty,
  openTableTalkModal,
  closeTableTalkModal,
  handleTableTalkPenaltyChange,
  handlePenaltyPointsChange,
  toggleProMode,
  handleUndo,
  handleRedo,
  handleBidSelect,
  handleBiddingPointsToggle,
  openZeroPointsModal,
  handleGameOverFixClick,
  handleGameOverSaveClick,
  openProbabilityModal,
  closeProbabilityModal,
  handleFormSubmit,
  handleTeamClick,
  handleManualSaveGame,
  openResumeGameModal,
  closeResumeGameModal,
  handleResumeGameSubmit,
  openTeamSelectionModal,
  closeTeamSelectionModal,
  handleTeamSelectionSubmit,
  openConfirmationModal,
  closeConfirmationModal,
  viewSavedGame,
  closeViewSavedGameModal,
  deleteSavedGame,
  deleteFreezerGame,
  loadFreezerGame,
  handleDeleteTeam,
  loadCurrentGameState,
  saveCurrentGameState,
  resetGame,
  renderApp,
  performTeamPlayerMigration,
};

Object.assign(window, globalBindings);

// --- Initialization ---
document.addEventListener("DOMContentLoaded", () => {
  performTeamPlayerMigration();
  document.body.classList.remove('modal-open');
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.classList.remove('modal-active');
  }
  document.querySelectorAll('.modal').forEach(modal => modal.classList.add('hidden'));
  enforceDarkMode();
  initializeTheme(); // Predefined themes
  initializeCustomThemeColors(); // Custom primary/accent
  loadCurrentGameState(); // Load after theme
  loadSettings(); // Load settings after game state

  // Pro mode toggle (in settings modal, not main nav)
  const proModeToggleModal = document.getElementById("proModeToggleModal");
  if (proModeToggleModal) {
      proModeToggleModal.checked = getLocalStorage(PRO_MODE_KEY, false);
      proModeToggleModal.addEventListener("change", (e) => toggleProMode(e.target));
  }
  updateProModeUI(getLocalStorage(PRO_MODE_KEY, false)); // Initial UI update

  const closeViewSavedGameModalBtn = document.getElementById("closeViewSavedGameModalBtn");
  if (closeViewSavedGameModalBtn) {
    closeViewSavedGameModalBtn.addEventListener("click", (e) => { e.stopPropagation(); closeViewSavedGameModal(); });
  }
  const closeSavedGamesModalBtn = document.getElementById("closeSavedGamesModalBtn");
  if (closeSavedGamesModalBtn) {
    closeSavedGamesModalBtn.addEventListener("click", (e) => { e.stopPropagation(); closeSavedGamesModal(); });
  }
  const teamSelectionForm = document.getElementById("teamSelectionForm");
  if (teamSelectionForm) {
    teamSelectionForm.addEventListener("submit", handleTeamSelectionSubmit);
  }
  const resumePaperGameButton = document.getElementById("resumePaperGameButton");
  if (resumePaperGameButton) {
    resumePaperGameButton.addEventListener("click", (event) => {
      event.preventDefault();
      openResumeGameModal();
      toggleMenu(event);
    });
  }
  let touchStartX = 0;
  document.body.addEventListener('touchstart', (e) => {
      if (e.changedTouches && e.changedTouches.length) {
          touchStartX = e.changedTouches[0].clientX;
      }
  }, { passive: true });

  // Close modals on outside click (simplified)
  const modalCloseHandlers = {
    savedGamesModal: closeSavedGamesModal,
    viewSavedGameModal: closeViewSavedGameModal,
    aboutModal: closeAboutModal,
    statisticsModal: closeStatisticsModal,
    teamSelectionModal: closeTeamSelectionModal,
    resumeGameModal: closeResumeGameModal,
    settingsModal: closeSettingsModal,
    themeModal: () => closeThemeModal(null),
    confirmationModal: closeConfirmationModal,
    presetEditorModal: closePresetEditorModal,
    tableTalkModal: closeTableTalkModal,
    probabilityModal: closeProbabilityModal,
  };

  document.addEventListener("click", (e) => {
    Object.entries(modalCloseHandlers).forEach(([id, handler]) => {
      const modalEl = document.getElementById(id);
      if (modalEl && !modalEl.classList.contains("hidden") && e.target === modalEl) {
        handler();
      }
    });
  });
  document.body.addEventListener('touchend', e => {
      if (!e.changedTouches || !e.changedTouches.length) return;
      const touchEndX = e.changedTouches[0].clientX;
      const menu = document.getElementById("menu");
      if (!menu) return;
      const menuOpen = menu.classList.contains("show");
      if (touchStartX < 50 && touchEndX > touchStartX + 50 && !menuOpen) {
        toggleMenu(e);
      } else if (menuOpen && touchEndX < touchStartX - 50) {
        toggleMenu(e);
      }
  }, { passive: true });
});

if ('serviceWorker' in navigator) {
  let refreshing;
  // Proactively ask existing registrations to check for updates
  try {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.update().catch(() => {})));
  } catch (_) {}
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    window.location.reload();
    refreshing = true;
  });
  window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js') // Assuming sw is in root
          .then(registration => {
              registration.onupdatefound = () => {
                  const installingWorker = registration.installing;
                  if (installingWorker == null) return;
                  installingWorker.onstatechange = () => {
                      if (installingWorker.state === 'installed') {
                          if (navigator.serviceWorker.controller) {
                              // New update available
                              if (confirm('New version available! Reload to update?')) {
                                  installingWorker.postMessage({ type: 'SKIP_WAITING' });
                              }
                          }
                      }
                  };
              };
          }).catch(error => console.error('Service Worker registration failed:', error));
  });
}

function undoPenaltyFlag() {
  updateState({ pendingPenalty: null });
  showSaveIndicator("Penalty removed");
}

function handleTeamSelectionCancel() {
  if (state.gameOver) {
    openConfirmationModal(
      'The game is completed. Canceling will erase this game. Are you sure?',
      () => { closeTeamSelectionModal(); resetGame(); closeConfirmationModal(); },
      closeConfirmationModal
    );
  } else {
    closeTeamSelectionModal();
  }
}

// Swipe-and-drag gesture for menu open/close
(function() {
    const menu = document.getElementById("menu");
    const overlay = document.getElementById("menuOverlay");
    const icon = document.getElementById("hamburgerIcon");
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    let isOpening = false;
    const menuWidth = menu.offsetWidth;

    function onTouchStart(e) {
        startX = e.touches[0].clientX;
        currentX = startX;
        const menuOpen = menu.classList.contains("show");
        if (!menuOpen && startX <= 20) {
            isDragging = true;
            isOpening = true;
            menu.style.transition = "none";
            overlay.classList.add("show");
            overlay.style.opacity = "0";
            document.body.classList.add("overflow-hidden");
        } else if (menuOpen) {
            isDragging = true;
            isOpening = false;
            menu.style.transition = "none";
            overlay.classList.add("show");
        }
    }

    function onTouchMove(e) {
        if (!isDragging) return;
        currentX = e.touches[0].clientX;
        let deltaX = currentX - startX;
        if (isOpening) {
            const left = Math.min(0, -menuWidth + currentX);
            menu.style.left = left + "px";
            overlay.style.opacity = (menuWidth + left) / menuWidth;
        } else {
            const left = Math.min(0, deltaX);
            menu.style.left = left + "px";
            overlay.style.opacity = (menuWidth + left) / menuWidth;
        }
    }

    function onTouchEnd() {
        if (!isDragging) return;
        isDragging = false;
        const deltaX = currentX - startX;
        const threshold = menuWidth / 3;
        let shouldOpen;
        if (isOpening) {
            shouldOpen = deltaX > threshold;
        } else {
            shouldOpen = deltaX > -threshold;
        }
        menu.style.transition = "";
        if (shouldOpen) {
            menu.classList.add("show");
            icon.classList.add("open");
            overlay.classList.add("show");
            document.body.classList.add("overflow-hidden");
        } else {
            menu.classList.remove("show");
            icon.classList.remove("open");
            overlay.classList.remove("show");
            document.body.classList.remove("overflow-hidden");
        }
        menu.style.left = "";
        overlay.style.opacity = "";
    }

    document.addEventListener("touchstart", onTouchStart, { passive: false });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
})();

// Expose selected helpers when running in a Node/CommonJS environment (e.g. tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitizePlayerName,
    ensurePlayersArray,
    canonicalizePlayers,
    formatTeamDisplay,
    buildTeamKey,
    parseLegacyTeamName,
    deriveTeamDisplay,
    getGameTeamDisplay,
    playersEqual,
    calculateWinProbability,
    renderProbabilityBreakdown,
  };
}
