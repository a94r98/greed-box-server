import { Router, Response } from "express";
import { prisma } from "../db";
import { AuthenticatedRequest, authenticateToken, restrictGuest } from "../authMiddleware";
import gameEngine from "../gameEngine";
import { trackTaskProgress } from "../taskTracker";

const router = Router();

// 1. Get Player Profile Info
router.get("/profile", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: "Unauthorized." });

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: "User profile not found." });
    }

    const wallet = await prisma.wallet.findUnique({
      where: { userId }
    });

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
        bio: user.bio || "",
        whatsapp: user.whatsapp || "",
        referralCode: user.referralCode,
        referredByCode: user.referredByCode,
        createdAt: user.createdAt,
        roundsPlayed: user.roundsPlayed,
        roundsWon: user.roundsWon,
        wallet: {
          freeBalance: wallet?.freeBalance || 0.0,
          cashBalance: wallet?.cashBalance || 0.0
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

// Update profile info (Nickname, Bio, Age, Gender, Whatsapp, Custom Avatar/Image)
router.put("/profile", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const { displayNickname, bio, whatsapp, age, gender, avatar } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "Unauthorized." });
  }

  try {
    const dataToUpdate: any = {};
    if (displayNickname !== undefined) dataToUpdate.displayNickname = displayNickname;
    if (bio !== undefined) dataToUpdate.bio = bio;
    if (whatsapp !== undefined) dataToUpdate.whatsapp = whatsapp;
    if (age !== undefined) dataToUpdate.age = age ? parseInt(age.toString()) : null;
    if (gender !== undefined) dataToUpdate.gender = gender;
    if (avatar !== undefined) dataToUpdate.avatar = avatar;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: dataToUpdate
    });

    return res.json({
      message: "Profile updated successfully.",
      user: {
        id: updated.id,
        publicId: updated.publicId,
        username: updated.username,
        displayNickname: updated.displayNickname,
        email: updated.email,
        avatar: updated.avatar,
        bio: updated.bio,
        whatsapp: updated.whatsapp,
        age: updated.age,
        gender: updated.gender
      }
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return res.status(500).json({ error: "Failed to update profile." });
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

  const limit = parseInt(req.query.limit as string) || 50;
  const page = parseInt(req.query.page as string) || 1;
  const yearVal = req.query.year ? parseInt(req.query.year as string) : null;
  const monthVal = req.query.month ? parseInt(req.query.month as string) : null;

  try {
    const offset = (page - 1) * limit;

    let countQuery = `SELECT COUNT(*) as count FROM "Bet" b WHERE b."userId" = $1`;
    const countParams: any[] = [userId];
    if (yearVal) {
      countParams.push(yearVal);
      countQuery += ` AND EXTRACT(YEAR FROM b."createdAt") = $${countParams.length}`;
    }
    if (monthVal) {
      countParams.push(monthVal);
      countQuery += ` AND EXTRACT(MONTH FROM b."createdAt") = $${countParams.length}`;
    }

    const countRows: any = await prisma.$queryRawUnsafe(countQuery, ...countParams);
    const total = parseInt(countRows[0]?.count ?? "0");

    let queryStr = `
      SELECT b.id, b."roundId", b."boxIndex", b.amount, b.currency, b.status, b."winAmount", b."createdAt",
             r."winningBox", r."winningMultiplier"
      FROM "Bet" b
      LEFT JOIN "Round" r ON b."roundId" = r.id
      WHERE b."userId" = $1
    `;
    const params: any[] = [userId];

    if (yearVal) {
      params.push(yearVal);
      queryStr += ` AND EXTRACT(YEAR FROM b."createdAt") = $${params.length}`;
    }
    if (monthVal) {
      params.push(monthVal);
      queryStr += ` AND EXTRACT(MONTH FROM b."createdAt") = $${params.length}`;
    }

    queryStr += ` ORDER BY b."createdAt" DESC`;

    params.push(limit, offset);
    queryStr += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const bets: any = await prisma.$queryRawUnsafe(queryStr, ...params);

    const formattedHistory = bets.map((b: any) => ({
      betId: b.id,
      roundId: b.roundId,
      boxIndex: b.boxIndex,
      amount: typeof b.amount === 'string' ? parseFloat(b.amount) : (b.amount || 0.0),
      currency: b.currency,
      status: b.status,
      winAmount: typeof b.winAmount === 'string' ? parseFloat(b.winAmount) : (b.winAmount || 0.0),
      winningBox: b.winningBox,
      winningMultiplier: typeof b.winningMultiplier === 'string' ? parseFloat(b.winningMultiplier) : b.winningMultiplier,
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

// 5. Daily Tasks List & Progress (Categorized & Lazy-Reset)
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

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Process lazy-resets for daily tasks on retrieval
    const updatedProgressList = [...progressList];
    for (let i = 0; i < updatedProgressList.length; i++) {
      const p = updatedProgressList[i];
      const task = tasks.find(t => t.id === p.taskId);
      if (task && task.type === "DAILY") {
        const progressDate = new Date(p.updatedAt);
        if (progressDate < todayStart) {
          const resetProgress = await prisma.taskProgress.update({
            where: { id: p.id },
            data: {
              count: 0,
              isCompleted: false,
              claimedAt: null
            }
          });
          updatedProgressList[i] = resetProgress;
        }
      }
    }

    const response = tasks.map(task => {
      let progress = updatedProgressList.find(p => p.taskId === task.id);
      return {
        id: task.id,
        key: task.key,
        title: task.title,
        description: task.description,
        goalCount: task.goalCount,
        rewardAmount: task.rewardAmount,
        rewardCurrency: task.rewardCurrency,
        type: task.type,
        actionType: task.actionType,
        linkUrl: task.linkUrl,
        count: progress?.count || 0,
        isCompleted: progress?.isCompleted || false,
        isClaimed: progress?.claimedAt !== null && progress?.claimedAt !== undefined
      };
    });

    return res.json({ tasks: response });
  } catch (error) {
    console.error("Failed to load tasks:", error);
    return res.status(500).json({ error: "Failed to load tasks." });
  }
});

// 5.1 Play Heartbeat (Periodic Online Minutes tracker)
router.post("/tasks/heartbeat", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: "Unauthorized." });

  try {
    await trackTaskProgress(userId, "ONLINE_MINUTES", 1);
    return res.json({ success: true, message: "Heartbeat recorded." });
  } catch (error) {
    console.error("Heartbeat error:", error);
    return res.status(500).json({ error: "Heartbeat failed." });
  }
});

// 5.2 Social Action Trigger
router.post("/tasks/action", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const { actionType } = req.body;
  if (!userId) return res.status(400).json({ error: "Unauthorized." });
  if (!actionType) return res.status(400).json({ error: "Action type is required." });

  try {
    await trackTaskProgress(userId, actionType, 1);
    return res.json({ success: true, message: `Action ${actionType} recorded.` });
  } catch (error) {
    console.error("Action trigger error:", error);
    return res.status(500).json({ error: "Failed to record action." });
  }
});

// 6. Claim Task Reward (Handles cumulative check and badges)
router.post("/tasks/:id/claim", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const taskId = req.params.id;
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: "Unauthorized." });

  try {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const task = await prisma.dailyTask.findUnique({ where: { id: taskId } });
    if (!task) {
      return res.status(404).json({ error: "Task not found." });
    }

    let progress = await prisma.taskProgress.findFirst({
      where: { userId, taskId }
    });

    if (!progress) {
      if (task.key === "complete_all_daily") {
        const otherDailyTasks = await prisma.dailyTask.findMany({
          where: {
            type: "DAILY",
            key: { not: "complete_all_daily" },
            isEnabled: true
          }
        });

        const otherProgress = await prisma.taskProgress.findMany({
          where: { userId }
        });

        let allCompleted = true;
        for (const t of otherDailyTasks) {
          const p = otherProgress.find(op => op.taskId === t.id);
          if (!p) {
            allCompleted = false;
            break;
          }
          const progressDate = new Date(p.updatedAt);
          if (progressDate < todayStart || !p.isCompleted) {
            allCompleted = false;
            break;
          }
        }

        if (!allCompleted) {
          return res.status(400).json({ error: "يجب إكمال جميع المهام اليومية الأخرى أولاً للحصول على هذه المكافأة." });
        }

        progress = await prisma.taskProgress.create({
          data: {
            userId,
            taskId: task.id,
            count: otherDailyTasks.length,
            isCompleted: true
          }
        });
      } else {
        return res.status(404).json({ error: "Task progress not found." });
      }
    } else {
      // Check daily task lazy reset before checking completion status
      if (task.type === "DAILY") {
        const progressDate = new Date(progress.updatedAt);
        if (progressDate < todayStart) {
          return res.status(400).json({ error: "Task is not completed yet." });
        }
      }

      // Dynamic verification for "complete_all_daily" if progress exists
      if (task.key === "complete_all_daily") {
        const otherDailyTasks = await prisma.dailyTask.findMany({
          where: {
            type: "DAILY",
            key: { not: "complete_all_daily" },
            isEnabled: true
          }
        });

        const otherProgress = await prisma.taskProgress.findMany({
          where: { userId }
        });

        let allCompleted = true;
        for (const t of otherDailyTasks) {
          const p = otherProgress.find(op => op.taskId === t.id);
          if (!p) {
            allCompleted = false;
            break;
          }
          const progressDate = new Date(p.updatedAt);
          if (progressDate < todayStart || !p.isCompleted) {
            allCompleted = false;
            break;
          }
        }

        if (!allCompleted) {
          return res.status(400).json({ error: "يجب إكمال جميع المهام اليومية الأخرى أولاً للحصول على هذه المكافأة." });
        }

        if (!progress.isCompleted) {
          progress = await prisma.taskProgress.update({
            where: { id: progress.id },
            data: { isCompleted: true }
          });
        }
      }
    }

    if (!progress.isCompleted) {
      return res.status(400).json({ error: "Task is not completed yet." });
    }
    if (progress.claimedAt) {
      return res.status(400).json({ error: "Task reward has already been claimed." });
    }

    const rewardAmount = task.rewardAmount;
    const currency = task.rewardCurrency;

    // Credit reward atomically
    await prisma.$transaction(async (tx: any) => {
      // Mark task claimed
      await tx.taskProgress.update({
        where: { id: progress.id },
        data: { claimedAt: new Date() }
      });

      // Credit wallet (freeBalance = diamonds, cashBalance = coins)
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
          description: `Claimed Task Reward: ${task.title}`
        }
      });

      // Assign badge if claiming join all official pages
      if (task.key === "social_join_all") {
        await tx.user.update({
          where: { id: userId },
          data: { badge: "عضو داعم" }
        });
      }
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
    const rounds = await prisma.$queryRaw`
      SELECT * FROM "Round"
      WHERE "winningBox" IS NOT NULL
      ORDER BY "startAt" DESC
      LIMIT 20
    `;
    return res.json({ rounds });
  } catch (err) {
    console.error("Failed to fetch recent rounds:", err);
    return res.status(500).json({ error: "Failed to fetch recent rounds." });
  }
});

// 10. Get Specific Round Winners Detail
router.get("/rounds/:id", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const roundId = req.params.id;
  try {
    const round = await prisma.round.findUnique({
      where: { id: roundId }
    });
    if (!round) return res.status(404).json({ error: "Round not found." });

    const topWinnersRows = await prisma.$queryRaw`
      SELECT b."winAmount", u.username, u.avatar
      FROM "Bet" b
      JOIN "User" u ON b."userId" = u.id
      WHERE b."roundId" = ${roundId} AND b.status = 'WON'
      ORDER BY b."winAmount" DESC
      LIMIT 3
    `;

    const topWinners = topWinnersRows.map((b: any) => ({
      username: b.username || "لاعب",
      avatar: b.avatar || "avatar_1",
      winAmount: typeof b.winAmount === 'string' ? parseFloat(b.winAmount) : (b.winAmount || 0.0)
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
    console.error("Failed to fetch round details:", err);
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

// ─── REFERRAL SYSTEM ─────────────────────────────────────────────────────────

// Get player referrals list
router.get("/referrals", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  try {
    const referrals = await prisma.$queryRaw`
      SELECT r.id, r."bonusPaid", r."createdAt", u.username, u."displayNickname", u."publicId"
      FROM "Referral" r
      JOIN "User" u ON r."inviteeId" = u.id
      WHERE r."inviterId" = ${userId}
      ORDER BY r."createdAt" DESC
    `;

    const config = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });

    return res.json({
      referrals: referrals.map((ref: any) => ({
        id: ref.id,
        inviteeId: ref.publicId,
        username: ref.displayNickname || ref.username || "لاعب",
        date: ref.createdAt,
        status: ref.bonusPaid ? "تم الدفع" : "قيد المعالجة"
      })),
      isReferralActive: config?.isReferralActive ?? true,
      inviteReward: config?.inviteRewardInviter ?? 500.0
    });
  } catch (error) {
    console.error("Fetch referrals error:", error);
    return res.status(500).json({ error: "Failed to fetch referrals." });
  }
});

// Apply a referral code
router.post("/referrals/apply", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: "كود الدعوة مطلوب." });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود." });
    }

    if (user.referredByCode) {
      return res.status(400).json({ error: "لقد قمت بإدخال كود دعوة مسبقاً." });
    }

    if (user.referralCode === code) {
      return res.status(400).json({ error: "لا يمكنك استخدام كود الدعوة الخاص بك." });
    }

    const inviter = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!inviter) {
      return res.status(404).json({ error: "كود الدعوة غير صالح." });
    }

    const config = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    if (config && !config.isReferralActive) {
      return res.status(400).json({ error: "نظام الدعوات غير نشط حالياً." });
    }

    const rewardInviter = config?.inviteRewardInviter ?? 500.0;
    const rewardInvitee = config?.inviteRewardInvitee ?? 200.0;

    await prisma.$transaction(async (tx: any) => {
      // Update invitee referredByCode
      await tx.user.update({
        where: { id: userId },
        data: { referredByCode: code }
      });

      // Credit inviter wallet
      const inviterWallet = await tx.wallet.findUnique({ where: { userId: inviter.id } });
      if (inviterWallet) {
        await tx.wallet.update({
          where: { userId: inviter.id },
          data: { cashBalance: inviterWallet.cashBalance + rewardInviter }
        });
      }

      // Credit invitee wallet
      const inviteeWallet = await tx.wallet.findUnique({ where: { userId: userId } });
      if (inviteeWallet) {
        await tx.wallet.update({
          where: { userId: userId },
          data: { cashBalance: inviteeWallet.cashBalance + rewardInvitee }
        });
      }

      // Create referral relation
      await tx.referral.create({
        data: {
          inviterId: inviter.id,
          inviteeId: userId,
          bonusPaid: true
        }
      });

      // Create transaction logs
      await tx.transaction.create({
        data: {
          userId: inviter.id,
          amount: rewardInviter,
          currency: 'CASH',
          type: 'REFERRAL_BONUS',
          description: `كود دعوة: مكافأة دعوة مستخدم جديد (${user.displayNickname || user.username})`
        }
      });

      await tx.transaction.create({
        data: {
          userId: userId,
          amount: rewardInvitee,
          currency: 'CASH',
          type: 'REFERRAL_BONUS',
          description: `كود دعوة: مكافأة تسجيل باستخدام كود دعوة (${inviter.displayNickname || inviter.username})`
        }
      });
    });

    return res.json({
      message: "تم تطبيق كود الدعوة بنجاح والحصول على المكافأة!",
      inviteReward: rewardInvitee
    });
  } catch (error) {
    console.error("Apply referral code error:", error);
    return res.status(500).json({ error: "فشل تطبيق كود الدعوة." });
  }
});

// ─── SUPPORT CHAT SYSTEM ─────────────────────────────────────────────────────

// Get support messages
router.get("/support/messages", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  try {
    const messages = await prisma.supportMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" }
    });
    return res.json({ messages });
  } catch (error) {
    console.error("Get support messages error:", error);
    return res.status(500).json({ error: "Failed to load support chat." });
  }
});

// Send support message
router.post("/support/messages", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.user?.id;
  const { message, imageUrl } = req.body;

  try {
    const newMessage = await prisma.supportMessage.create({
      data: {
        userId,
        sender: "USER",
        message: message || null,
        imageUrl: imageUrl || null
      }
    });

    // Mock agent reply after 1.5 seconds
    setTimeout(async () => {
      try {
        await prisma.supportMessage.create({
          data: {
            userId,
            sender: "AGENT",
            message: "مرحباً بك! شكراً لتواصلك مع الدعم الفني لـ Greedy Box. لقد استلمنا رسالتك وسنقوم بالرد عليك في أقرب وقت ممكن. 🛠️"
          }
        });
      } catch (err) {
        console.error("Mock agent reply error:", err);
      }
    }, 1500);

    return res.json({ message: newMessage });
  } catch (error) {
    console.error("Send support message error:", error);
    return res.status(500).json({ error: "Failed to send message." });
  }
});

// Get support WhatsApp and Telegram config links
router.get("/support/config", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  try {
    const config = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    return res.json({
      supportTelegram: config?.supportTelegram || "",
      supportWhatsApp: config?.supportWhatsApp || ""
    });
  } catch (error) {
    console.error("Get support config error:", error);
    return res.status(500).json({ error: "Failed to load support configuration." });
  }
});

export default router;
