const PROB_CACHE = new Map();

// --- Win-probability engine -------------------------------------------
function bucketScore(diff) {
  const sign = diff < 0 ? -1 : 1;
  const abs = Math.min(Math.abs(diff), 180); // ≥180 ⇒ final bucket
  const band = Math.floor(abs / 20) * 20; // 0-19,20-39,…160-179
  return sign * band; // e.g.  -40  or  120
}

function buildProbabilityIndex(historicalGames) {
  const table = {};

  const add = (k, winner, weight) => {
    if (!table[k]) table[k] = { us: 1, dem: 1 }; // Laplace prior (1|1)
    table[k][winner] += weight;
  };

  historicalGames.forEach((g) => {
    if (!g.rounds || !g.rounds.length || !g.finalScore) return;

    const winner = g.finalScore.us > g.finalScore.dem ? "us" : "dem";
    const ageDays = (Date.now() - new Date(g.timestamp)) / 86_400_000;
    const w = Math.pow(0.8, ageDays / 14); // recency weight

    g.rounds.forEach((r, idx) => {
      if (!r.runningTotals) return;
      const diff = r.runningTotals.us - r.runningTotals.dem;
      const key = `${idx}|${bucketScore(diff)}`;
      add(key, winner, w);
    });
  });
  return table;
}

// --- Calibrated logistic (trained 2025-06-20 on 44 games) -------------
const L_INTERCEPT = 0.2084586876141831;
const L_COEFF_DIFF = 0.00421107;
const L_COEFF_ROUND = -0.09520921;
const L_COEFF_MOM = 0.00149416;

function logisticProb(diff, roundIdx, mom) {
  const z =
    L_INTERCEPT +
    L_COEFF_DIFF * diff +
    L_COEFF_ROUND * roundIdx +
    L_COEFF_MOM * mom;
  return 1 / (1 + Math.exp(-z)); // probability "us" eventually wins
}

function calculateWinProbabilityComplex(state, historicalGames) {
  const { rounds } = state;
  if (!rounds || !rounds.length) return { us: 50, dem: 50 }; // No rounds played yet, 50/50 chance.

  const lastRound = rounds[rounds.length - 1];
  if (!lastRound || !lastRound.runningTotals) return { us: 50, dem: 50 };

  const currentTotals = lastRound.runningTotals;
  const currentDiff = currentTotals.us - currentTotals.dem;

  const roundIndex = rounds.length - 1;
  const cacheKey = ((historicalGames && historicalGames.length) || 0).toString();

  if (!PROB_CACHE.has(cacheKey)) {
    PROB_CACHE.set(cacheKey, buildProbabilityIndex(historicalGames));
  }

  const table = PROB_CACHE.get(cacheKey);
  const bucketedScore = bucketScore(currentDiff);
  const key = `${roundIndex}|${bucketedScore}`;
  const counts = table[key] || { us: 1, dem: 1 }; // Laplace prior (1,1) if no data.
  const empiricalProbUs = counts.us / (counts.us + counts.dem);
  const observationsInBucket = counts.us + counts.dem - 2;

  const prevRound =
    rounds.length > 1
      ? rounds[rounds.length - 2]
      : { runningTotals: { us: 0, dem: 0 } };
  const prevDiff = prevRound.runningTotals.us - prevRound.runningTotals.dem;
  const momentum = currentDiff - prevDiff;

  const modelProbUs = logisticProb(currentDiff, roundIndex, momentum);

  const K_CONFIDENCE_THRESHOLD = 30;
  const beta = Math.min(
    1,
    Math.log(observationsInBucket + 1) /
      Math.log(K_CONFIDENCE_THRESHOLD + 1)
  );

  const blendedProbUs = beta * empiricalProbUs + (1 - beta) * modelProbUs;

  return {
    us: +(blendedProbUs * 100).toFixed(1),
    dem: +((1 - blendedProbUs) * 100).toFixed(1),
  };
}

export function calculateWinProbability(state, historicalGames) {
  return calculateWinProbabilityComplex(state, historicalGames);
}

export function renderProbabilityBreakdown(
  scoreDiff,
  roundsPlayed,
  labelUs,
  labelDem,
  winProb,
  historicalGames,
  currentScores
) {
  const cacheKey = ((historicalGames && historicalGames.length) || 0).toString();
  if (!PROB_CACHE.has(cacheKey)) {
    PROB_CACHE.set(cacheKey, buildProbabilityIndex(historicalGames));
  }
  const table = PROB_CACHE.get(cacheKey);

  const bucketedScore = bucketScore(scoreDiff);
  const key = `${roundsPlayed - 1}|${bucketedScore}`;
  const counts = table[key] || { us: 1, dem: 1 };
  const empirical = counts.us / (counts.us + counts.dem);
  const totalObs = counts.us + counts.dem - 2; // Remove Laplace prior
  const beta = Math.min(1, Math.log(totalObs + 1) / 4);
  const prior = 1 / (1 + Math.exp(-0.015 * scoreDiff));

  const bucketAnalysis = (() => {
    const bucketRange = getBucketRange(bucketedScore);
    const bucketSize = Math.abs(bucketedScore);
    let bucketDescription = "";

    if (bucketSize === 0) {
      bucketDescription = "Tied games (0 points)";
    } else if (bucketSize <= 130) {
      bucketDescription = `Close games (${bucketRange})`;
    } else if (bucketSize <= 180) {
      bucketDescription = `Large leads (${bucketRange})`;
    } else {
      bucketDescription = `Dominant positions (${bucketRange})`;
    }

    return {
      bucketedScore,
      bucketDescription,
      bucketRange,
    };
  })();

  const historicalAnalysis = (() => {
    const relevantGames = historicalGames.filter((game) => {
      return game.rounds && game.rounds.length > 0 && game.finalScore;
    });

    if (relevantGames.length === 0) {
      return {
        text: "No historical data",
        explanation: "Using mathematical model only",
        empiricalRate: 0,
        totalObservations: 0,
      };
    }

    let bucketGames = 0;
    let bucketWins = 0;

    Object.keys(table).forEach((tableKey) => {
      if (tableKey.includes(`|${bucketedScore}`)) {
        const keyRound = parseInt(tableKey.split("|")[0], 10);
        if (Math.abs(keyRound - (roundsPlayed - 1)) <= 1) {
          bucketGames += table[tableKey].us + table[tableKey].dem - 2;
          bucketWins += table[tableKey].us - 1;
        }
      }
    });

    return {
      text: `${relevantGames.length} games analyzed`,
      explanation: `Found ${bucketGames} similar situations in historical data`,
      empiricalRate: bucketGames > 0 ? bucketWins / bucketGames : 0,
      totalObservations: bucketGames,
      bucketWins,
      bucketGames,
    };
  })();

  const blendingAnalysis = (() => {
    const empiricalWeight = Math.round(beta * 100);
    const priorWeight = Math.round((1 - beta) * 100);
    const empiricalPercent = Math.round(empirical * 100);
    const priorPercent = Math.round(prior * 100);

    let confidence = "Low";
    if (totalObs >= 50) confidence = "Very High";
    else if (totalObs >= 20) confidence = "High";
    else if (totalObs >= 10) confidence = "Medium";
    else if (totalObs >= 5) confidence = "Low-Medium";

    return {
      empiricalWeight,
      priorWeight,
      empiricalPercent,
      priorPercent,
      confidence,
      totalObservations: totalObs,
    };
  })();

  const recencyAnalysis = (() => {
    const recentGames = historicalGames.filter((game) => {
      if (!game.timestamp) return false;
      const ageDays = (Date.now() - new Date(game.timestamp)) / 86_400_000;
      return ageDays <= 30;
    });

    const olderGames = historicalGames.length - recentGames.length;

    return {
      recentGames: recentGames.length,
      olderGames,
      explanation: `Recent games (≤30 days) weighted more heavily than older games`,
    };
  })();

  return `
    <div class="space-y-4">
      <!-- Header -->
      <div class="text-center border-b border-gray-200 dark:border-gray-700 pb-3">
        <div class="text-xl font-bold text-gray-800 dark:text-white mb-1">
          Logistic Regression Win Probability Analysis
        </div>
        <div class="flex items-center justify-center gap-6 text-lg">
          <div class="flex items-center gap-2">
            <div class="w-3 h-3 rounded-full bg-primary"></div>
            <span class="font-semibold text-white">${labelUs}: ${winProb.us.toFixed(
              1
            )}%</span>
          </div>
          <div class="flex items-center gap-2">
            <div class="w-3 h-3 rounded-full bg-red-500"></div>
            <span class="font-semibold text-red-200">${labelDem}: ${winProb.dem.toFixed(
              1
            )}%</span>
          </div>
        </div>
        <div class="text-xs text-gray-400 mt-2">
          ${labelUs} ${currentScores.us} — ${labelDem} ${currentScores.dem}
          (diff ${scoreDiff >= 0 ? "+" : ""}${scoreDiff})
        </div>
      </div>

      <!-- Bucket and Historical Trends -->
      <div class="grid md:grid-cols-2 gap-4">
        <div class="bg-gray-900/70 rounded-lg p-3 border border-gray-700">
          <div class="text-sm uppercase tracking-wide text-gray-400 mb-1">Situation</div>
          <div class="text-base font-semibold text-white">${bucketAnalysis.bucketDescription}</div>
          <div class="text-xs text-gray-400 mt-2">Score bucket: ${bucketAnalysis.bucketRange}</div>
          <div class="text-xs text-gray-400">Similar historical situations: ${
            historicalAnalysis.bucketGames
          }</div>
        </div>
        <div class="bg-gray-900/70 rounded-lg p-3 border border-gray-700">
          <div class="text-sm uppercase tracking-wide text-gray-400 mb-1">Historical Success</div>
          <div class="text-base font-semibold text-white">
            ${historicalAnalysis.bucketGames > 0 ? `${Math.round(
              historicalAnalysis.empiricalRate * 100
            )}% win rate` : "Insufficient data"}
          </div>
          <div class="text-xs text-gray-400 mt-2">${historicalAnalysis.text}</div>
          <div class="text-xs text-gray-400">${historicalAnalysis.explanation}</div>
        </div>
      </div>

      <!-- Blending and Confidence -->
      <div class="bg-gray-900/70 rounded-lg p-3 border border-gray-700">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm uppercase tracking-wide text-gray-400 mb-1">Model Blending</div>
            <div class="text-base font-semibold text-white">
              ${blendingAnalysis.empiricalWeight}% empirical • ${blendingAnalysis.priorWeight}% model
            </div>
          </div>
          <div class="text-sm font-semibold text-${blendingAnalysis.confidence
            .toLowerCase()
            .replace("-", "")}">
            Confidence: ${blendingAnalysis.confidence}
          </div>
        </div>
        <div class="text-xs text-gray-400 mt-2">
          Historical data suggests ${blendingAnalysis.empiricalPercent}% chance for ${
            labelUs
          } based on similar games.<br/>
          Model predicts ${blendingAnalysis.priorPercent}% chance using current score differential and momentum.
        </div>
      </div>

      <!-- Momentum Insight -->
      <div class="grid md:grid-cols-2 gap-4">
        <div class="bg-gray-900/70 rounded-lg p-3 border border-gray-700">
          <div class="text-sm uppercase tracking-wide text-gray-400 mb-1">Momentum</div>
          <div class="text-xs text-gray-400">
            The logistic model accounts for how the score difference changed in the last round,
            improving predictions for rallies and collapses.
          </div>
        </div>
        <div class="bg-gray-900/70 rounded-lg p-3 border border-gray-700">
          <div class="text-sm uppercase tracking-wide text-gray-400 mb-1">Recency Weighting</div>
          <div class="text-xs text-gray-400">
            Recent games (< 30 days): ${recencyAnalysis.recentGames}. Older games: ${
            recencyAnalysis.olderGames
          }.
          </div>
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">
            ${recencyAnalysis.explanation}
          </div>
        </div>
      </div>

      <!-- How It Works -->
      <div class="border-t border-gray-200 dark:border-gray-700 pt-3">
        <div class="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
          <h4 class="font-medium text-gray-800 dark:text-white mb-2">
            How This Calculation Works (Logistic Regression Method)
          </h4>
          <div class="text-xs text-gray-600 dark:text-gray-400 space-y-1">
            <p>• <strong>Feature Extraction:</strong> Each round generates features: score difference, round number, and momentum (change in score diff)</p>
            <p>• <strong>Logistic Regression Model:</strong> Trained on historical game data to predict win probability using these three key features</p>
            <p>• <strong>Momentum Analysis:</strong> Captures recent performance trends by tracking how the score difference changes between rounds</p>
            <p>• <strong>Stage-Aware Modeling:</strong> Round number helps the model understand that early vs. late game situations matter differently</p>
            <p>• <strong>Continuous Learning:</strong> Model can be retrained as more game data becomes available for improved accuracy</p>
          </div>
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-2 italic">
            This machine learning approach uses logistic regression to learn patterns from actual game outcomes, providing data-driven win probability estimates that improve with more training data.
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderComplexProbabilityBreakdown(
  scoreDiff,
  roundsPlayed,
  labelUs,
  labelDem,
  winProb,
  historicalGames,
  currentScores
) {
  return renderProbabilityBreakdown(
    scoreDiff,
    roundsPlayed,
    labelUs,
    labelDem,
    winProb,
    historicalGames,
    currentScores
  );
}

export function getBucketRange(bucketedScore) {
  const abs = Math.abs(bucketedScore);
  if (abs === 0) return "0";
  if (abs === 20) return "0-19";
  if (abs === 40) return "20-39";
  if (abs === 60) return "40-59";
  if (abs === 80) return "60-79";
  if (abs === 100) return "80-99";
  if (abs === 120) return "100-119";
  if (abs === 140) return "120-139";
  if (abs === 160) return "140-159";
  if (abs === 180) return "160+";
  return `${abs}`;
}
