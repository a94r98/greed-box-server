import { Router, Response } from "express";
import { prisma } from "../db";
import { AuthenticatedRequest, authenticateToken, restrictGuest } from "../authMiddleware";
import gameEngine from "../gameEngine";

const router = Router();

// 1. Get Player Profile Info
router.get("/profile", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: "Unauthorized." });

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true }
    });

    if (!user) {
      return res.status(404).json({ error: "User profile not found." });
    }

    // Compute financial aggregates from transaction history
    const transactions = await prisma.transaction.findMany({
      where: { userId }
    });

    let totalProfitFree = 0;
    let totalLossFree = 0;
    let totalProfitCash = 0;
    let totalLossCash = 0;

    transactions.forEach((tx) => {
      if (tx.currency === "FREE") {
        if (tx.amount > 0) totalProfitFree += tx.amount;
        else if (tx.type === "BET_PLACE") totalLossFree += Math.abs(tx.amount);
      } else {
        if (tx.amount > 0 && tx.type === "BET_WIN") totalProfitCash += tx.amount;
        else if (tx.type === "BET_PLACE") totalLossCash += Math.abs(tx.amount);
      }
    });

    return res.json({
      profile: {
        id: user.id,
        publicId: user.publicId,
        username: user.username,
        displayNickname: user.displayNickname,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        age: user.age,
        gender: user.gender,
        referralCode: user.referralCode,
        referredByCode: user.referredByCode,
        createdAt: user.createdAt,
        roundsPlayed: user.roundsPlayed,
        roundsWon: user.roundsWon,
        wallet: {
          freeBalance: user.wallet?.freeBalance || 0.0,
          cashBalance: user.wallet?.cashBalance || 0.0
        },
        stats: {
          totalProfitFree,
          totalLossFree,
          totalProfitCash,
          totalLossCash
        }
      }
    });
  } catch (error) {
    console.error("Fetch profile error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// 2. Update Avatar
router.put("/profile/avatar", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const { avatar } = req.body;

  if (!userId || !avatar) {
    return res.status(400).json({ error: "Avatar field is required." });
  }

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { avatar }
    });
    return res.json({ message: "Avatar updated.", avatar: updated.avatar });
  } catch (error) {
    return res.status(500).json({ error: "Failed to update avatar." });
  }
});

// 3. Betting History (My History)
router.get("/history", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: "Unauthorized." });

  const limit = parseInt(req.query.limit as string) || 20;
  const page = parseInt(req.query.page as string) || 1;

  try {
    const total = await prisma.bet.count({ where: { userId } });
    const bets = await prisma.bet.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: (page - 1) * limit,
      include: {
        round: {
          select: {
            winningBox: true,
            winningMultiplier: true
          }
        }
      }
    });

    const formattedHistory = bets.map(b => ({
      betId: b.id,
      roundId: b.roundId,
      boxIndex: b.boxIndex,
      amount: b.amount,
      currency: b.currency,
      status: b.status,
      winAmount: b.winAmount,
      winningBox: b.round?.winningBox,
      winningMultiplier: b.round?.winningMultiplier,
      createdAt: b.createdAt
    }));

    return res.json({
      history: formattedHistory,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error("Fetch history error:", error);
    return res.status(500).json({ error: "Failed to load history." });
  }
});

// 4. In-App Leaderboards / Rankings (Based on Cash wagers)
router.get("/rankings", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;

  try {
    // 1. Group wagers by userId where currency is CASH
    const wagers = await prisma.bet.groupBy({
      by: ["userId"],
      where: { currency: "CASH" }
    });

    // 2. Sort wagers in memory
    const formatted = wagers.map((row: any) => ({
      userId: row.userId,
      totalWagered: parseFloat(row._sum || row.sum || row.amount || "0")
    }));
    formatted.sort((a: any, b: any) => b.totalWagered - a.totalWagered);

    // 3. Fetch all user details to merge profiles
    const users = await prisma.user.findMany();

    const rankings = formatted.map((item: any, idx: number) => {
      const u = users.find((user: any) => user.id === item.userId);
      return {
        rank: idx + 1,
        userId: item.userId,
        publicId: u?.publicId || "",
        username: u?.username || "Player",
        displayNickname: u?.displayNickname || u?.username || "لاعب",
        avatar: u?.avatar || "avatar_1",
        gender: u?.gender || "MALE",
        value: item.totalWagered
      };
    });

    // 4. Get requesting user stats
    const myIndex = rankings.findIndex((r: any) => r.userId === userId);
    let myRankInfo: any = null;

    if (userId) {
      const u = users.find((user: any) => user.id === userId);
      const myWagered = myIndex !== -1 ? rankings[myIndex].value : 0;
      const myRank = myIndex !== -1 ? myIndex + 1 : -1;
      
      let coinsToRank99 = 0;
      if (myRank > 99 || myRank === -1) {
        const rank99Value = rankings.length >= 99 ? rankings[98].value : 0;
        coinsToRank99 = Math.max(0, rank99Value - myWagered);
      }

      myRankInfo = {
        rank: myRank,
        value: myWagered,
        displayNickname: u?.displayNickname || u?.username || "أنت",
        publicId: u?.publicId || "",
        avatar: u?.avatar || "avatar_1",
        gender: u?.gender || "MALE",
        coinsToRank99
      };
    }

    // Return top 100
    return res.json({
      rankings: rankings.slice(0, 100),
      myRank: myRankInfo
    });
  } catch (error) {
    console.error("Fetch rankings error:", error);
    return res.status(500).json({ error: "Failed to load rankings." });
  }
});

// 5. Daily Tasks List & Progress
router.get("/tasks", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: "Unauthorized." });

  try {
    const tasks = await prisma.dailyTask.findMany({
      where: { isEnabled: true }
    });

    const progressList = await prisma.taskProgress.findMany({
      where: { userId }
    });

    const response = tasks.map(task => {
      let progress = progressList.find(p => p.taskId === task.id);
      return {
        id: task.id,
        key: task.key,
        title: task.title,
        description: task.description,
        goalCount: task.goalCount,
        rewardAmount: task.rewardAmount,
        rewardCurrency: task.rewardCurrency,
        count: progress?.count || 0,
        isCompleted: progress?.isCompleted || false,
        isClaimed: progress?.claimedAt !== null && progress?.claimedAt !== undefined
      };
    });

    return res.json({ tasks: response });
  } catch (error) {
    return res.status(500).json({ error: "Failed to load daily tasks." });
  }
});

// 6. Claim Daily Task Reward
router.post("/tasks/:id/claim", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const taskId = req.params.id;

  if (!userId) return res.status(400).json({ error: "Unauthorized." });

  try {
    const progress = await prisma.taskProgress.findUnique({
      where: { userId_taskId: { userId, taskId } },
      include: { task: true }
    });

    if (!progress) {
      return res.status(404).json({ error: "Task progress not found." });
    }
    if (!progress.isCompleted) {
      return res.status(400).json({ error: "Task is not completed yet." });
    }
    if (progress.claimedAt) {
      return res.status(400).json({ error: "Task reward has already been claimed." });
    }

    const rewardAmount = progress.task.rewardAmount;
    const currency = progress.task.rewardCurrency;

    // Credit reward atomically
    await prisma.$transaction(async (tx) => {
      // Mark task claimed
      await tx.taskProgress.update({
        where: { id: progress.id },
        data: { claimedAt: new Date() }
      });

      // Credit wallet
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (wallet) {
        const balanceData = currency === "FREE"
          ? { freeBalance: wallet.freeBalance + rewardAmount }
          : { cashBalance: wallet.cashBalance + rewardAmount };

        await tx.wallet.update({
          where: { userId },
          data: balanceData
        });
      }

      // Record transaction
      await tx.transaction.create({
        data: {
          userId,
          amount: rewardAmount,
          currency,
          type: "DAILY_TASK_BONUS",
          description: `Claimed Daily Task Reward: ${progress.task.title}`
        }
      });
    });

    return res.json({
      message: "Reward claimed successfully.",
      reward: { amount: rewardAmount, currency }
    });
  } catch (error) {
    console.error("Task claim error:", error);
    return res.status(500).json({ error: "Claim operation failed." });
  }
});

// 7. Request Deposit (Charging - Standard User Only)
router.post("/deposit", authenticateToken, restrictGuest, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const { amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid deposit amount." });
  }

  try {
    const deposit = await prisma.deposit.create({
      data: {
        userId,
        amount,
        status: "PENDING"
      }
    });

    return res.status(201).json({
      message: "Deposit request submitted successfully. Awaiting administration approval.",
      deposit
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to submit deposit request." });
  }
});

// 8. Request Withdrawal (Standard User Only)
router.post("/withdrawal", authenticateToken, restrictGuest, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const { amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid withdrawal amount." });
  }

  // Soft lock queue to prevent race conditions during calculating/finalizing round phases
  let responseSent = false;
  await gameEngine.queuePoolOperation(async () => {
    try {
      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      if (!wallet || wallet.cashBalance < amount) {
        res.status(400).json({ error: "Insufficient Cash Coin balance." });
        responseSent = true;
        return;
      }

      // Deduct balance immediately to reserve it, creating a holding withdrawal
      await prisma.$transaction(async (tx) => {
        await tx.wallet.update({
          where: { userId },
          data: { cashBalance: wallet.cashBalance - amount }
        });

        await tx.withdrawal.create({
          data: {
            userId,
            amount,
            status: "PENDING"
          }
        });

        await tx.transaction.create({
          data: {
            userId,
            amount: -amount,
            currency: "CASH",
            type: "WITHDRAWAL",
            description: `Withdrew ${amount} (Pending admin approval)`
          }
        });
      });

      res.status(201).json({
        message: "Withdrawal request submitted successfully. Pending processing."
      });
      responseSent = true;
    } catch (err) {
      console.error(err);
      if (!responseSent) {
        res.status(500).json({ error: "Failed to process withdrawal." });
        responseSent = true;
      }
    }
  });
});

// 9. Get Recent 20 Rounds with Winners & Chest shapes details
router.get("/rounds/recent", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  try {
    const rounds = await prisma.round.findMany({
      where: { winningBox: { not: null } },
      orderBy: { startAt: "desc" },
      take: 20
    });
    return res.json({ rounds });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch recent rounds." });
  }
});

// 10. Get Specific Round Winners Detail
router.get("/rounds/:id", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const roundId = req.params.id;
  try {
    const round = await prisma.round.findUnique({
      where: { id: roundId },
      include: {
        bets: {
          where: { status: "WON" },
          orderBy: { winAmount: "desc" },
          take: 3,
          include: { user: { select: { username: true, avatar: true } } }
        }
      }
    });
    if (!round) return res.status(404).json({ error: "Round not found." });

    const topWinners = round.bets.map(b => ({
      username: b.user.username || "لاعب",
      avatar: b.user.avatar || "avatar_1",
      winAmount: b.winAmount
    }));

    return res.json({
      round: {
        id: round.id,
        sequenceNumber: round.sequenceNumber,
        winningBox: round.winningBox,
        winningMultiplier: round.winningMultiplier,
        currencyMode: round.currencyMode
      },
      topWinners
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch round details." });
  }
});

// 11. Add free or paid coins instantly for testing
router.post("/testing/add-coins", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const { amount, currency } = req.body;
  if (!userId) return res.status(400).json({ error: "Unauthorized." });

  const addAmount = parseFloat(amount) || 100000.0;
  const isFree = currency === "CASH" ? false : true;

  try {
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return res.status(404).json({ error: "Wallet not found." });

    const updated = await prisma.wallet.update({
      where: { userId },
      data: isFree
        ? { freeBalance: wallet.freeBalance + addAmount }
        : { cashBalance: wallet.cashBalance + addAmount }
    });

    await prisma.transaction.create({
      data: {
        userId,
        amount: addAmount,
        currency: isFree ? "FREE" : "CASH",
        type: "DAILY_TASK_BONUS",
        description: `Refilled ${addAmount} ${isFree ? 'FREE' : 'CASH'} via testing button`
      }
    });

    return res.json({
      message: "Refill successful.",
      wallet: {
        freeBalance: updated.freeBalance,
        cashBalance: updated.cashBalance
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Refill failed." });
  }
});

export default router;
