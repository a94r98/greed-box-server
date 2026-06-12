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

export function runSimulation(params: SimulationParams): SimulationReport {
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
    const bets: SimulatedBet[] = [];
    const botsToBet = Math.floor(botCount * (0.5 + Math.random() * 0.5));

    for (let b = 0; b < botsToBet; b++) {
      const boxIndex = Math.floor(Math.random() * 8);
      const amount = Math.floor(betMin + Math.random() * (betMax - betMin));
      bets.push({ boxIndex, amount });
    }

    const totalBetsAmount = bets.reduce((sum, item) => sum + item.amount, 0);

    const calculation = calculateWinningBox({
      bets,
      poolBalance: currentPool,
      currencyMode
    });

    const winningBox = calculation.winningBox;
    const multiplier = BOX_MULTIPLIERS[winningBox];
    
    const winningBetsTotal = bets
      .filter(bet => bet.boxIndex === winningBox)
      .reduce((sum, item) => sum + item.amount, 0);
      
    const winPayout = winningBetsTotal * multiplier;
    const roundNet = totalBetsAmount - winPayout;
    currentPool += roundNet;

    frequencies[winningBox] = (frequencies[winningBox] || 0) + 1;
    payoutCurve.push(currentPool);
  }

  let stabilityScore = 100;
  if (poolDrained) {
    stabilityScore = 0;
  } else {
    const retentionRatio = currentPool / initialPool;
    if (retentionRatio < 0.5) {
      stabilityScore -= 40;
    } else if (retentionRatio < 0.8) {
      stabilityScore -= 20;
    }
    
    const minPoolVal = Math.min(...payoutCurve);
    if (minPoolVal < initialPool * 0.2) {
      stabilityScore -= 30;
    } else if (minPoolVal < initialPool * 0.5) {
      stabilityScore -= 15;
    }
  }

  stabilityScore = Math.max(0, stabilityScore);

  return {
    roundsRun,
    initialPool,
    finalPool: Math.max(0, currentPool),
    netProfitLoss: currentPool - initialPool,
    profitLossPct: ((currentPool - initialPool) / initialPool) * 100,
    boxWinningFrequencies: frequencies,
    stabilityScore,
    payoutCurve
  };
}
