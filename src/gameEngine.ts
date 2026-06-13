import { Server } from "socket.io";
import { prisma } from "./db";
import { RoundState, CurrencyMode, EventType } from "./constants";
import { calculateWinningBox, SimulatedBet } from "./blackBox";
import { logEvent } from "./auditLogger";

export interface ActiveBet {
  userId: string;
  amount: number;
  boxIndex: number;
  currency: "FREE" | "CASH";
  clientBetId: string;
}

export class GameEngine {
  private io: Server | null = null;
  private currentRoundId: string = "";
  private currentStatus: RoundState = RoundState.ENDED;
  private currentCurrencyMode: "FREE" | "CASH" = "FREE";
  private sequenceNumber: number = 0;
  
  // Timers and monotonic track
  private phaseStartHrTime: [number, number] = [0, 0];
  private phaseDurationMs: number = 0;
  private timerRef: NodeJS.Timeout | null = null;
  
  // Cache of active bets for idempotency and fast calculations
  private activeBets: Map<string, ActiveBet[]> = new Map(); // userId -> bets[]
  private activeIdempotencyKeys: Set<string> = new Set(); // "userId:roundId:clientBetId"
  
  // Super Admin overrides
  private overrideBox: number | null = null;
  private overrideAdminId: string | null = null;
  private overrideReason: string | null = null;

  // Mid-cycle pool soft lock queue
  private isPoolLocked: boolean = false;
  private queuedPoolOperations: Array<() => Promise<any>> = [];

  // Cached winner details for instant broadcast
  private currentWinningBox: number | null = null;
  private currentWinningMultiplier: number | null = null;

  constructor() {
    this.currentStatus = RoundState.ENDED;
  }

  public setIo(io: Server) {
    this.io = io;
  }

  public getCurrentRound() {
    const elapsedMs = this.getElapsedMs();
    const remainingMs = Math.max(0, this.phaseDurationMs - elapsedMs);
    
    return {
      roundId: this.currentRoundId,
      status: this.currentStatus,
      currencyMode: this.currentCurrencyMode,
      remainingMs,
      sequenceNumber: this.sequenceNumber,
      serverTimestamp: Date.now(),
      winningBox: (this.currentStatus === RoundState.REVEALING || this.currentStatus === RoundState.FINALIZING) ? this.currentWinningBox : null,
      winningMultiplier: (this.currentStatus === RoundState.REVEALING || this.currentStatus === RoundState.FINALIZING) ? this.currentWinningMultiplier : null
    };
  }

  public getUserBets(userId: string): ActiveBet[] {
    return this.activeBets.get(userId) || [];
  }

  // Safe queue for balance changes during pool lock
  public async queuePoolOperation(operation: () => Promise<any>) {
    if (this.isPoolLocked) {
      console.log("[Pool Lock] Operation queued (Calculating/Finalizing phase active).");
      this.queuedPoolOperations.push(operation);
    } else {
      await operation();
    }
  }

  private async processQueuedOperations() {
    console.log(`[Pool Lock] Processing ${this.queuedPoolOperations.length} queued pool operations.`);
    while (this.queuedPoolOperations.length > 0) {
      const operation = this.queuedPoolOperations.shift();
      if (operation) {
        try {
          await operation();
        } catch (err) {
          console.error("Error running queued pool operation:", err);
        }
      }
    }
  }

  // Setup Monotonic Timing helper
  private startPhaseTimer(durationSeconds: number) {
    this.phaseStartHrTime = process.hrtime();
    this.phaseDurationMs = durationSeconds * 1000;
  }

  private getElapsedMs(): number {
    const diff = process.hrtime(this.phaseStartHrTime);
    return Math.floor((diff[0] * 1e9 + diff[1]) / 1e6);
  }

  // Trigger Manual Override
  public setOverride(box: number, adminId: string, reason: string) {
    if (this.currentStatus === RoundState.FINALIZING) {
      throw new Error("Cannot set override during round finalization.");
    }
    this.overrideBox = box;
    this.overrideAdminId = adminId;
    this.overrideReason = reason;
  }

  // Place bet function (Idempotency, Isolation, Validation)
  public async placeBet(userId: string, boxIndex: number, amount: number, clientBetId: string): Promise<ActiveBet> {
    if (this.currentStatus !== RoundState.BETTING) {
      throw new Error("Bets are locked for the current round.");
    }

    const config = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    if (!config) throw new Error("System configuration not found.");

    if (amount < config.minBet || amount > config.maxBet) {
      throw new Error(`Bet amount must be between ${config.minBet} and ${config.maxBet}.`);
    }

    if (boxIndex < 0 || boxIndex > 7) {
      throw new Error("Invalid box index selected.");
    }

    const idempotencyKey = `${userId}:${this.currentRoundId}:${clientBetId}`;
    if (this.activeIdempotencyKeys.has(idempotencyKey)) {
      // Re-fetch and return existing bet to handle client retry gracefully
      const userBets = this.activeBets.get(userId) || [];
      const existing = userBets.find(b => b.clientBetId === clientBetId);
      if (existing) return existing;
      throw new Error("Idempotency conflict detected.");
    }

    // Atomic isolation checks using db transaction
    const betResult = await prisma.$transaction(async (tx) => {
      // 1. Fetch wallet
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new Error("Wallet not found.");

      const isFree = this.currentCurrencyMode === "FREE";
      const userBalance = isFree ? wallet.freeBalance : wallet.cashBalance;

      if (userBalance < amount) {
        throw new Error("Insufficient balance.");
      }

      // 2. Enforce Payout Exposure Limit check
      const totalBetsOnBox = (this.activeBets.get(userId) || [])
        .filter(b => b.boxIndex === boxIndex)
        .reduce((sum, b) => sum + b.amount, 0) + amount;
        
      const pool = await tx.housePool.findUnique({
        where: { type: this.currentCurrencyMode }
      });
      if (!pool) throw new Error("House Pool not found.");

      // Check exposure cap: Limit single box payouts from exceeding e.g. 50% of house pool
      const boxMultiplier = boxIndex <= 3 ? 5 : (boxIndex === 4 ? 10 : (boxIndex === 5 ? 15 : (boxIndex === 6 ? 25 : 45)));
      const potentialPayout = totalBetsOnBox * boxMultiplier;
      const exposureLimit = pool.balance * 0.50; // 50% cap

      if (potentialPayout > exposureLimit) {
        throw new Error("Target box payout exceeds house exposure capacity.");
      }

      // 3. Subtract balance
      const balanceData = isFree
        ? { freeBalance: wallet.freeBalance - amount }
        : { cashBalance: wallet.cashBalance - amount };

      await tx.wallet.update({
        where: { userId },
        data: balanceData
      });

      // 4. Record Transaction
      await tx.transaction.create({
        data: {
          userId,
          amount: -amount,
          currency: this.currentCurrencyMode,
          type: "BET_PLACE",
          description: `Placed bet of ${amount} on Box ${boxIndex} (Round: ${this.currentRoundId.substring(0, 8)})`
        }
      });

      // 5. Create Bet Record
      const bet = await tx.bet.create({
        data: {
          userId,
          roundId: this.currentRoundId,
          clientBetId,
          boxIndex,
          amount,
          currency: this.currentCurrencyMode,
          status: "PENDING"
        }
      });

      // 6. Update Round totals
      if (isFree) {
        await tx.round.update({
          where: { id: this.currentRoundId },
          data: { totalBetsFree: { increment: amount } }
        });
      } else {
        await tx.round.update({
          where: { id: this.currentRoundId },
          data: { totalBetsCash: { increment: amount } }
        });
      }

      return bet;
    });

    // ─── TASK SYSTEM TRIGGERS ──────────────────────────────────────────────
    try {
      const { trackTaskProgress } = require("./taskTracker");
      if (this.currentCurrencyMode === "FREE") {
        await trackTaskProgress(userId, "USE_DIAMONDS", 1);
      } else {
        await trackTaskProgress(userId, "BET_COINS", Math.round(amount));
        await trackTaskProgress(userId, "FIRST_BET", 1);
      }
    } catch (taskErr) {
      console.error("Error updating tasks on bet placement:", taskErr);
    }

    // Cache locally
    const activeBet: ActiveBet = {
      userId,
      amount: betResult.amount,
      boxIndex: betResult.boxIndex,
      currency: betResult.currency as "FREE" | "CASH",
      clientBetId: betResult.clientBetId
    };

    const userBets = this.activeBets.get(userId) || [];
    userBets.push(activeBet);
    this.activeBets.set(userId, userBets);
    this.activeIdempotencyKeys.add(idempotencyKey);

    // Broadcast current round bets update to other sockets
    this.broadcastBetsChange();

    await logEvent({
      roundId: this.currentRoundId,
      eventType: EventType.BET_PLACED,
      userId,
      message: `User ${userId} placed bet ${amount} on box ${boxIndex}`
    });

    return activeBet;
  }

  private broadcastBetsChange() {
    let totalFree = 0;
    let totalCash = 0;
    const boxBets: Record<number, { free: number; cash: number }> = {};
    for (let i = 0; i < 8; i++) {
      boxBets[i] = { free: 0, cash: 0 };
    }

    this.activeBets.forEach((bets) => {
      bets.forEach(b => {
        if (b.currency === "FREE") {
          totalFree += b.amount;
          boxBets[b.boxIndex].free += b.amount;
        } else {
          totalCash += b.amount;
          boxBets[b.boxIndex].cash += b.amount;
        }
      });
    });

    this.io?.emit("bets_update", {
      totalFree,
      totalCash,
      boxBets
    });
  }

  // Game Engine Cycle loop initializer
  public async start() {
    console.log("Starting Greed Boxes Real-Time Engine Loop...");
    await this.nextRound();
  }

  private async nextRound() {
    // 1. End pool lock
    this.isPoolLocked = false;
    await this.processQueuedOperations();

    // 2. Read config
    const config = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    const bettingDuration = config?.roundDurationBetting || 20;

    // 3. Clear local caches
    this.activeBets.clear();
    this.activeIdempotencyKeys.clear();
    this.overrideBox = null;
    this.overrideAdminId = null;
    this.overrideReason = null;
    this.currentWinningBox = null;
    this.currentWinningMultiplier = null;

    // 4. Alternate currency mode depending on settings
    const isFree = config?.isFreeEnabled ?? true;
    const isCash = config?.isCashEnabled ?? true;
    
    if (isFree && isCash) {
      // Alternate
      this.currentCurrencyMode = this.currentCurrencyMode === "FREE" ? "CASH" : "FREE";
    } else if (isCash) {
      this.currentCurrencyMode = "CASH";
    } else {
      this.currentCurrencyMode = "FREE";
    }

    // 5. Create new database Round entry
    this.sequenceNumber++;
    const newRound = await prisma.round.create({
      data: {
        status: RoundState.BETTING,
        currencyMode: this.currentCurrencyMode === "FREE" ? "FREE_ONLY" : "CASH_ONLY",
        sequenceNumber: this.sequenceNumber
      }
    });

    this.currentRoundId = newRound.id;
    this.currentStatus = RoundState.BETTING;

    console.log(`[Round Engine] Started Round ${this.currentRoundId} (Mode: ${this.currentCurrencyMode})`);
    
    this.startPhaseTimer(bettingDuration);
    this.broadcastState();

    // Log Start
    await logEvent({
      roundId: this.currentRoundId,
      eventType: EventType.ROUND_START,
      message: `Started Round ${this.currentRoundId} in ${this.currentCurrencyMode} mode.`
    });

    // Schedule tick
    this.runTick();
  }

  private runTick() {
    if (this.timerRef) clearTimeout(this.timerRef);

    const elapsed = this.getElapsedMs();
    const remaining = this.phaseDurationMs - elapsed;

    if (remaining <= 0) {
      // Transition to next state
      this.transitionState();
    } else {
      // Tick remaining seconds
      this.timerRef = setTimeout(() => {
        this.io?.emit("timer_tick", {
          roundId: this.currentRoundId,
          remainingMs: Math.max(0, remaining - 1000)
        });
        this.runTick();
      }, Math.min(1000, remaining));
    }
  }

  private async transitionState() {
    const config = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    
    if (this.currentStatus === RoundState.BETTING) {
      // Lock bets
      this.currentStatus = RoundState.LOCKED;
      console.log(`[Round Engine] Bets locked for Round ${this.currentRoundId}`);
      
      // Lock Pool
      this.isPoolLocked = true;

      await prisma.round.update({
        where: { id: this.currentRoundId },
        data: { status: RoundState.LOCKED }
      });
      
      this.broadcastState();

      // Go immediately to calculating
      this.currentStatus = RoundState.CALCULATING;
      this.startPhaseTimer(config?.roundDurationCalcul || 3);
      this.broadcastState();
      
      // Process calculations
      await this.processCalculation();
      this.runTick();

    } else if (this.currentStatus === RoundState.CALCULATING) {
      // Calculations are finished, reveal winner
      this.currentStatus = RoundState.REVEALING;
      this.startPhaseTimer(config?.roundDurationReveal || 5);
      this.broadcastState();
      this.runTick();

    } else if (this.currentStatus === RoundState.REVEALING) {
      // Begin Payout Distribution
      this.currentStatus = RoundState.FINALIZING;
      this.startPhaseTimer(5); // 5 seconds results window duration
      this.broadcastState();
      
      await this.processFinalization();
      this.runTick();

    } else if (this.currentStatus === RoundState.FINALIZING) {
      // Finished finalization, transition to ended
      this.currentStatus = RoundState.ENDED;
      this.broadcastState();
      
      // Restart loop
      setTimeout(async () => {
        // Verify maintenance mode
        const liveConfig = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
        if (liveConfig?.isMaintenanceMode) {
          console.log("[Round Engine] Maintenance Mode active. Game engine paused.");
          this.io?.emit("maintenance_alert", { message: liveConfig.maintenanceMessage });
        } else {
          await this.nextRound();
        }
      }, 1000);
    }
  }

  // Calculates winner using Black Box Risk engine
  private async processCalculation() {
    try {
      const pool = await prisma.housePool.findUnique({
        where: { type: this.currentCurrencyMode }
      });
      if (!pool) throw new Error("Active pool not found.");

      const allBetsList: SimulatedBet[] = [];
      this.activeBets.forEach((bets) => {
        bets.forEach(b => {
          allBetsList.push({ boxIndex: b.boxIndex, amount: b.amount });
        });
      });

      // Calculate outcome
      const calculation = calculateWinningBox({
        bets: allBetsList,
        poolBalance: pool.balance,
        currencyMode: this.currentCurrencyMode,
        overrideBox: this.overrideBox
      });

      // Write snapshots
      await prisma.roundSnapshot.create({
        data: {
          roundId: this.currentRoundId,
          poolFreeBalance: this.currentCurrencyMode === "FREE" ? pool.balance : 0,
          poolCashBalance: this.currentCurrencyMode === "CASH" ? pool.balance : 0,
          totalBetsFree: this.currentCurrencyMode === "FREE" ? allBetsList.reduce((sum, b) => sum + b.amount, 0) : 0,
          totalBetsCash: this.currentCurrencyMode === "CASH" ? allBetsList.reduce((sum, b) => sum + b.amount, 0) : 0,
          betsJson: JSON.stringify(allBetsList),
          resultBox: calculation.winningBox,
          isOverride: calculation.isOverride,
          overrideAdminId: this.overrideAdminId
        }
      });

      this.currentWinningBox = calculation.winningBox;
      this.currentWinningMultiplier = calculation.winningMultiplier;

      // Update Round info in DB
      await prisma.round.update({
        where: { id: this.currentRoundId },
        data: {
          winningBox: calculation.winningBox,
          winningMultiplier: calculation.winningMultiplier,
          status: RoundState.CALCULATING
        }
      });

      if (calculation.isOverride) {
        await logEvent({
          roundId: this.currentRoundId,
          eventType: EventType.ADMIN_OVERRIDE,
          message: `Admin override triggered: winning box set to ${calculation.winningBox}. Reason: ${this.overrideReason}`
        });
      }

      console.log(`[Round Engine] Calculated Winning Box: ${calculation.winningBox} (x${calculation.winningMultiplier})`);
    } catch (err) {
      console.error("Error during calculation phase:", err);
    }
  }

  // Distributes payouts and updates House Pool
  private async processFinalization() {
    console.log(`[Round Engine] Finalizing Round payouts for ${this.currentRoundId}`);
    
    try {
      const round = await prisma.round.findUnique({
        where: { id: this.currentRoundId },
        include: { bets: true }
      });
      if (!round || round.winningBox === null || round.winningBox === undefined) {
        throw new Error("Round details or winning box not found.");
      }

      const winningBox = round.winningBox;
      const multiplier = round.winningMultiplier || 5.0;
      const isFree = this.currentCurrencyMode === "FREE";

      let totalPayout = 0;
      let totalBetsVolume = 0;

      // Executing atomic transaction to process payouts and adjust pools
      await prisma.$transaction(async (tx) => {
        // Double check house pool availability inside transaction block
        const pool = await tx.housePool.findUnique({
          where: { type: this.currentCurrencyMode }
        });
        if (!pool) throw new Error("Segmented House pool not found.");

        const bets = await tx.bet.findMany({
          where: { roundId: this.currentRoundId }
        });

        // 1. Process each bet
        for (const bet of bets) {
          totalBetsVolume += bet.amount;
          const isWinner = bet.boxIndex === winningBox;

          if (isWinner) {
            const winReward = bet.amount * multiplier;
            totalPayout += winReward;

            // Update bet record
            await tx.bet.update({
              where: { id: bet.id },
              data: {
                status: "WON",
                winAmount: winReward
              }
            });

            // Credit player wallet
            const wallet = await tx.wallet.findUnique({ where: { userId: bet.userId } });
            if (wallet) {
              const balanceData = isFree
                ? { freeBalance: wallet.freeBalance + winReward }
                : { cashBalance: wallet.cashBalance + winReward };

              await tx.wallet.update({
                where: { userId: bet.userId },
                data: balanceData
              });
            }

            // Write logs
            await tx.transaction.create({
              data: {
                userId: bet.userId,
                amount: winReward,
                currency: this.currentCurrencyMode,
                type: "BET_WIN",
                description: `Winnings of ${winReward} credited for Box ${winningBox} (Round: ${this.currentRoundId.substring(0, 8)})`
              }
            });

            // Update User counts
            await tx.user.update({
              where: { id: bet.userId },
              data: {
                roundsPlayed: { increment: 1 },
                roundsWon: { increment: 1 }
              }
            });
          } else {
            // Player lost
            await tx.bet.update({
              where: { id: bet.id },
              data: { status: "LOST" }
            });

            await tx.user.update({
              where: { id: bet.userId },
              data: { roundsPlayed: { increment: 1 } }
            });
          }
        }

        // 2. Adjust segmented house pool
        const netPoolChange = totalBetsVolume - totalPayout;
        const newPoolBalance = pool.balance + netPoolChange;

        if (newPoolBalance < 0) {
          throw new Error("Transactional safety check failed: pool balance cannot drop below zero.");
        }

        await tx.housePool.update({
          where: { type: this.currentCurrencyMode },
          data: { balance: newPoolBalance }
        });

        // Record house pool logs
        await tx.housePoolLog.create({
          data: {
            poolType: this.currentCurrencyMode,
            amountChange: netPoolChange,
            type: netPoolChange >= 0 ? "BET_REVENUE" : "PAYOUT_EXPENSE",
            referenceId: this.currentRoundId
          }
        });

        // 3. Update Round totals
        if (isFree) {
          await tx.round.update({
            where: { id: this.currentRoundId },
            data: {
              totalPayoutFree: totalPayout,
              status: RoundState.ENDED
            }
          });
        } else {
          await tx.round.update({
            where: { id: this.currentRoundId },
            data: {
              totalPayoutCash: totalPayout,
              status: RoundState.ENDED
            }
          });
        }
      });

      // ─── TASK SYSTEM TRIGGERS ──────────────────────────────────────────────
      try {
        const roundBets = await prisma.bet.findMany({
          where: { roundId: this.currentRoundId }
        });

        const playerSummaries: Record<string, {
          totalBet: number;
          totalWin: number;
          hasWin: boolean;
          maxMultiplier: number;
        }> = {};

        for (const b of roundBets) {
          if (!playerSummaries[b.userId]) {
            playerSummaries[b.userId] = {
              totalBet: 0,
              totalWin: 0,
              hasWin: false,
              maxMultiplier: 0
            };
          }
          const summary = playerSummaries[b.userId];
          summary.totalBet += b.amount;
          if (b.status === "WON") {
            summary.totalWin += b.winAmount;
            summary.hasWin = true;
            if (this.currentWinningMultiplier && this.currentWinningMultiplier > summary.maxMultiplier) {
              summary.maxMultiplier = this.currentWinningMultiplier;
            }
          }
        }

        const { trackTaskProgress } = require("./taskTracker");

        for (const [userId, summary] of Object.entries(playerSummaries)) {
          await trackTaskProgress(userId, "PLAY_ROUNDS", 1);
          await trackTaskProgress(userId, "PLAY_ROUNDS_TOTAL", 1);

          if (summary.hasWin) {
            await trackTaskProgress(userId, "WIN_ROUNDS", 1);
            await trackTaskProgress(userId, "FIRST_WIN", 1);

            if (!isFree) {
              const netProfit = summary.totalWin - summary.totalBet;
              if (netProfit > 0) {
                await trackTaskProgress(userId, "WIN_PROFIT_TOTAL", Math.round(netProfit));
              }
            }

            if (summary.maxMultiplier >= 45) {
              await trackTaskProgress(userId, "WIN_WITH_45X", 1);
            }
          }
        }
      } catch (taskErr) {
        console.error("Error updating tasks on round end:", taskErr);
      }

      console.log(`[Round Engine] Completed payouts. Total Bets: ${totalBetsVolume}, Total Winnings Paid: ${totalPayout}`);
      
      let topWinners: any[] = [];
      try {
        const roundWinners = await prisma.bet.findMany({
          where: { roundId: this.currentRoundId, status: "WON" },
          orderBy: { winAmount: "desc" },
          take: 3,
          include: { user: true }
        });
        topWinners = roundWinners.map(w => ({
          username: w.user.username || "لاعب",
          avatar: w.user.avatar || "avatar_1",
          winAmount: w.winAmount
        }));
      } catch (err) {
        console.error("Error fetching top winners for round:", err);
      }

      this.io?.emit("round_reveal", {
        roundId: this.currentRoundId,
        winningBox,
        winningMultiplier: multiplier,
        topWinners
      });

      await logEvent({
        roundId: this.currentRoundId,
        eventType: EventType.PAYOUT,
        message: `Payout completed. Winning Box: ${winningBox}, Total Volume: ${totalBetsVolume}, Payout: ${totalPayout}`
      });

    } catch (err) {
      console.error("Payout finalization transaction failure:", err);
      
      // Fallback: If transaction fails (e.g. pool balance constraint), refund bets
      await this.refundActiveRoundBets();
    }
  }

  private async refundActiveRoundBets() {
    console.warn(`[Round Engine] Transaction Failure. Triggering refund for Round: ${this.currentRoundId}`);
    try {
      const bets = await prisma.bet.findMany({
        where: { roundId: this.currentRoundId, status: "PENDING" }
      });

      for (const bet of bets) {
        await prisma.$transaction(async (tx) => {
          const wallet = await tx.wallet.findUnique({ where: { userId: bet.userId } });
          if (wallet) {
            const balanceData = this.currentCurrencyMode === "FREE"
              ? { freeBalance: wallet.freeBalance + bet.amount }
              : { cashBalance: wallet.cashBalance + bet.amount };

            await tx.wallet.update({
              where: { userId: bet.userId },
              data: balanceData
            });
            
            await tx.transaction.create({
              data: {
                userId: bet.userId,
                amount: bet.amount,
                currency: this.currentCurrencyMode,
                type: "BET_REFUND",
                description: `Refunded bet of ${bet.amount} due to server error (Round: ${this.currentRoundId.substring(0, 8)})`
              }
            });
          }
          await tx.bet.update({
            where: { id: bet.id },
            data: { status: "LOST", winAmount: 0.0 }
          });
        });
      }

      await prisma.round.update({
        where: { id: this.currentRoundId },
        data: { status: RoundState.ENDED }
      });

      this.io?.emit("round_reveal", {
        roundId: this.currentRoundId,
        winningBox: -1, // error indicator
        winningMultiplier: 0
      });
    } catch (refundError) {
      console.error("Critical error during bet refunding:", refundError);
    }
  }

  private broadcastState() {
    const elapsed = this.getElapsedMs();
    const remainingMs = Math.max(0, this.phaseDurationMs - elapsed);

    this.io?.emit("round_state_change", {
      roundId: this.currentRoundId,
      status: this.currentStatus,
      currencyMode: this.currentCurrencyMode,
      remainingMs,
      sequenceNumber: this.sequenceNumber,
      serverTimestamp: Date.now(),
      winningBox: (this.currentStatus === RoundState.REVEALING || this.currentStatus === RoundState.FINALIZING) ? this.currentWinningBox : null,
      winningMultiplier: (this.currentStatus === RoundState.REVEALING || this.currentStatus === RoundState.FINALIZING) ? this.currentWinningMultiplier : null
    });
  }
}

export const gameEngine = new GameEngine();
export default gameEngine;
