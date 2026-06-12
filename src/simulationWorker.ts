import { parentPort, workerData } from "worker_threads";
import { calculateWinningBox, SimulatedBet } from "./blackBox";
import { BOX_MULTIPLIERS } from "./constants";

export interface SimulationParams {
  numRounds: number;
  initialPool: number;
  botCount: number;
  betMin: number;
  betMax: number;
  currencyMode: "FREE" | "CASH";
}

export interface SimulationReport {
  roundsRun: number;
  initialPool: number;
  finalPool: number;
  netProfitLoss: number;
  profitLossPct: number;
  boxWinningFrequencies: Record<number, number>;
  stabilityScore: number; // 0 to 100
  payoutCurve: number[];
}

function runSimulation(params: SimulationParams) {
  const { numRounds, initialPool, botCount, betMin, betMax, currencyMode } = params;
  
  let currentPool = initialPool;
  const frequencies: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const payoutCurve: number[] = [];
  
  let poolDrained = false;
  let roundsRun = 0;

  for (let r = 0; r < numRounds; r++) {
    if (currentPool <= 0) {
      poolDrained = true;
      break;
    }
    
    roundsRun++;
    // Generate simulated bets from bots
    const bets: SimulatedBet[] = [];
    const botsToBet = Math.floor(botCount * (0.5 + Math.random() * 0.5)); // Random participation

    for (let b = 0; b < botsToBet; b++) {
      // Pick a random box
      const boxIndex = Math.floor(Math.random() * 8);
      // Pick a random amount
      const amount = Math.floor(betMin + Math.random() * (betMax - betMin));
      bets.push({ boxIndex, amount });
    }

    const totalBetsAmount = bets.reduce((sum, item) => sum + item.amount, 0);

    // Call Black Box algorithm with virtual pool state
    const calculation = calculateWinningBox({
      bets,
      poolBalance: currentPool,
      currencyMode
    });

    const winningBox = calculation.winningBox;
    const multiplier = BOX_MULTIPLIERS[winningBox];
    
    // Calculate simulated payouts for winner bots
    const winningBetsTotal = bets
      .filter(bet => bet.boxIndex === winningBox)
      .reduce((sum, item) => sum + item.amount, 0);
      
    const winPayout = winningBetsTotal * multiplier;
    
    // Update virtual pool
    const roundNet = totalBetsAmount - winPayout;
    currentPool += roundNet;

    // Record frequencies and curve
    frequencies[winningBox] = (frequencies[winningBox] || 0) + 1;
    payoutCurve.push(currentPool);
  }

  // Calculate stability score
  // Penalize pool depletion or large high fluctuations
  let stabilityScore = 100;
  if (poolDrained) {
    stabilityScore = 0;
  } else {
    // Check final pool retention
    const retentionRatio = currentPool / initialPool;
    if (retentionRatio < 0.5) {
      stabilityScore -= 40; // Heavy drain
    } else if (retentionRatio < 0.8) {
      stabilityScore -= 20; // Moderate drain
    }
    
    // Check volatility: compute standard deviation or min values
    const minPoolVal = Math.min(...payoutCurve);
    if (minPoolVal < initialPool * 0.2) {
      stabilityScore -= 30; // Visited dangerous zones
    } else if (minPoolVal < initialPool * 0.5) {
      stabilityScore -= 15;
    }
  }

  stabilityScore = Math.max(0, stabilityScore);

  const report: SimulationReport = {
    roundsRun,
    initialPool,
    finalPool: Math.max(0, currentPool),
    netProfitLoss: currentPool - initialPool,
    profitLossPct: ((currentPool - initialPool) / initialPool) * 100,
    boxWinningFrequencies: frequencies,
    stabilityScore,
    payoutCurve
  };

  parentPort?.postMessage(report);
}

// Run simulation when thread spawns
if (workerData) {
  runSimulation(workerData as SimulationParams);
}
