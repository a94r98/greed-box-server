import { BOX_MULTIPLIERS } from "./constants";

export interface SimulatedBet {
  boxIndex: number;
  amount: number;
}

export interface BlackBoxInput {
  bets: SimulatedBet[];
  poolBalance: number;
  currencyMode: "FREE" | "CASH";
  exposureCapPct?: number; // default e.g. 50% (0.50)
  overrideBox?: number | null;
}

export interface BlackBoxResult {
  winningBox: number;
  winningMultiplier: number;
  simulatedPayout: number;
  isOverride: boolean;
  safeOutcomes: number[];
  payouts: Record<number, number>;
}

/**
 * Calculates the winning box for a round.
 * Implements risk weighting, exposure caps, and fallback states.
 */
export function calculateWinningBox(input: BlackBoxInput): BlackBoxResult {
  const { bets, poolBalance, currencyMode, exposureCapPct = 0.50, overrideBox } = input;
  
  // 1. Calculate total bets in current round
  const totalBets = bets.reduce((sum, b) => sum + b.amount, 0);
  
  // 2. Max Payout Limit = Pool + Total Bets
  const maxPayoutLimit = poolBalance + totalBets;
  const exposureLimit = poolBalance * exposureCapPct;

  // 3. Compute simulated payouts for all 8 boxes
  const payouts: Record<number, number> = {};
  for (let i = 0; i < 8; i++) {
    payouts[i] = 0;
  }
  
  bets.forEach((bet) => {
    const multiplier = BOX_MULTIPLIERS[bet.boxIndex] || 5;
    payouts[bet.boxIndex] += bet.amount * multiplier;
  });

  // 4. Handle Super Admin manual override
  if (overrideBox !== undefined && overrideBox !== null && overrideBox >= 0 && overrideBox < 8) {
    return {
      winningBox: overrideBox,
      winningMultiplier: BOX_MULTIPLIERS[overrideBox],
      simulatedPayout: payouts[overrideBox],
      isOverride: true,
      safeOutcomes: [overrideBox],
      payouts
    };
  }

  // 5. Evaluate Safe Boxes
  // Box is safe if:
  // - Simulated payout <= maxPayoutLimit
  // - Simulated payout <= exposureLimit
  const safeBoxes: number[] = [];
  const validBoxes: number[] = []; // boxes that don't exceed maxPayoutLimit, even if they violate exposureCap

  for (let i = 0; i < 8; i++) {
    const payout = payouts[i];
    const underMaxLimit = payout <= maxPayoutLimit;
    const underExposureCap = payout <= exposureLimit || payout <= totalBets; // Allow up to total bets of current round, since that doesn't deplete the pool
    
    if (underMaxLimit) {
      validBoxes.push(i);
      if (underExposureCap) {
        safeBoxes.push(i);
      }
    }
  }

  // Determine which list of boxes we can choose from
  // If we have strict safe boxes, use them. Else, fall back to valid boxes.
  let choices = safeBoxes.length > 0 ? safeBoxes : validBoxes;

  // 6. Fallback: No Safe Outcomes
  // If no box is under the max payout limit (very high bets on all boxes),
  // select the box that minimizes house loss (lowest payout).
  if (choices.length === 0) {
    let minPayoutBox = 0;
    let minPayoutValue = payouts[0];
    
    for (let i = 1; i < 8; i++) {
      if (payouts[i] < minPayoutValue) {
        minPayoutValue = payouts[i];
        minPayoutBox = i;
      }
    }
    
    return {
      winningBox: minPayoutBox,
      winningMultiplier: BOX_MULTIPLIERS[minPayoutBox],
      simulatedPayout: minPayoutValue,
      isOverride: false,
      safeOutcomes: [],
      payouts
    };
  }

  // 7. Risk Weighting & Weighted Selection
  // Weight formula: W_i = Max Payout Limit - P_i
  // The lower the simulated payout (more money retained by house), the higher the weight.
  const weights: Record<number, number> = {};
  let totalWeight = 0;
  
  choices.forEach((box) => {
    const payout = payouts[box];
    // Add small buffer to avoid 0 weight
    const weight = Math.max(0.1, maxPayoutLimit - payout);
    weights[box] = weight;
    totalWeight += weight;
  });

  // Roll the weighted random choice
  const rand = Math.random() * totalWeight;
  let cumulativeWeight = 0;
  let selectedBox = choices[0];

  for (const box of choices) {
    cumulativeWeight += weights[box];
    if (rand <= cumulativeWeight) {
      selectedBox = box;
      break;
    }
  }

  return {
    winningBox: selectedBox,
    winningMultiplier: BOX_MULTIPLIERS[selectedBox],
    simulatedPayout: payouts[selectedBox],
    isOverride: false,
    safeOutcomes: choices,
    payouts
  };
}
