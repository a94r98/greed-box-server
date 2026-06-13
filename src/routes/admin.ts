import { Router, Response } from "express";
import { Worker } from "worker_threads";
import path from "path";
import bcrypt from "bcrypt";
import { prisma } from "../db";
import { AuthenticatedRequest, authenticateToken, requireAdmin, requireSuperAdmin } from "../authMiddleware";
import gameEngine from "../gameEngine";
import { logEvent } from "../auditLogger";
import { EventType } from "../constants";
import { trackTaskProgress } from "../taskTracker";

const router = Router();

// Apply admin access middleware to all routes in this router
router.use(authenticateToken);
router.use(requireAdmin);

// 1. Get Live Stats
router.get("/stats", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const activeRound = gameEngine.getCurrentRound();
    const freePool = await prisma.housePool.findUnique({ where: { type: "FREE" } });
    const cashPool = await prisma.housePool.findUnique({ where: { type: "CASH" } });
    
    const usersCount = await prisma.user.count();
    const pendingDeposits = await prisma.deposit.count({ where: { status: "PENDING" } });
    const pendingWithdrawals = await prisma.withdrawal.count({ where: { status: "PENDING" } });

    // Calculate profit stats
    const today = new Date();
    today.setHours(0,0,0,0);

    const todayCashRevenue = await prisma.housePoolLog.aggregate({
      where: { poolType: "CASH", createdAt: { gte: today } },
      _sum: { amountChange: true }
    });

    return res.json({
      activeRound,
      pools: {
        free: freePool?.balance || 0,
        cash: cashPool?.balance || 0
      },
      counts: {
        users: usersCount,
        pendingDeposits,
        pendingWithdrawals
      },
      revenue: {
        todayCash: todayCashRevenue._sum.amountChange || 0
      }
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load admin stats." });
  }
});

// 2. Users List & Details
router.get("/users", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" }
    });
    const wallets = await prisma.wallet.findMany();
    const merged = users.map((u: any) => {
      const w = wallets.find((wallet: any) => wallet.userId === u.id);
      return {
        ...u,
        wallet: w ? { freeBalance: w.freeBalance, cashBalance: w.cashBalance } : null
      };
    });
    return res.json({ users: merged });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load users." });
  }
});

// Update user details (Name, Age, Gender, password, publicId, Ban options)
router.put("/users/:id", async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.params.id;
  const { displayNickname, age, gender, password, publicId, isBanned, banDays, banReason, removeAvatar, phoneNumber, countryCode, isVerified } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    const updateData: any = {};

    if (displayNickname !== undefined) updateData.displayNickname = displayNickname;
    if (age !== undefined) updateData.age = age ? parseInt(age) : null;
    if (gender !== undefined) updateData.gender = gender;
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber || null;
    if (countryCode !== undefined) updateData.countryCode = countryCode || null;
    
    if (removeAvatar) {
      updateData.avatar = "avatar_1";
    }

    if (isVerified !== undefined) {
      updateData.isVerified = isVerified;
    }

    if (password) {
      updateData.passwordHash = await bcrypt.hash(password, 10);
    }

    if (publicId !== undefined && publicId !== user.publicId) {
      // SuperAdmin validation required for modifying Public ID
      if (req.user?.role !== "SUPERADMIN") {
        return res.status(403).json({ error: "تغيير معرف المستخدم يتطلب صلاحيات Super Admin." });
      }

      // Validate unique public ID
      const existing = await prisma.user.findFirst({
        where: { publicId }
      });
      if (existing) {
        return res.status(400).json({ error: "الـ ID الجديد مستخدم بالفعل بحساب آخر." });
      }
      updateData.publicId = publicId;

      // Log event
      await prisma.eventLog.create({
        data: {
          eventType: "ADMIN_CHANGED_USER_ID",
          userId: user.id,
          message: `Old ID: ${user.publicId} | New ID: ${publicId} | Admin: ${req.user?.id}`
        }
      });
    }

    // Handle Ban
    if (isBanned !== undefined) {
      updateData.isBanned = isBanned;
      if (isBanned) {
        updateData.banReason = banReason || "حظر من قبل الإدارة";
        if (banDays && parseInt(banDays) > 0) {
          const expires = new Date();
          expires.setDate(expires.getDate() + parseInt(banDays));
          updateData.banExpiresAt = expires;
        } else {
          // Permanent Ban check: require SuperAdmin
          if (req.user?.role !== "SUPERADMIN") {
            return res.status(403).json({ error: "الحظر النهائي يتطلب صلاحيات Super Admin." });
          }
          updateData.banExpiresAt = null; // Permanent
        }
      } else {
        updateData.banExpiresAt = null;
        updateData.banReason = null;
      }

      await prisma.eventLog.create({
        data: {
          eventType: isBanned ? "ADMIN_BAN_USER" : "ADMIN_UNBAN_USER",
          userId: user.id,
          message: `User ${user.publicId} status updated to: Banned=${isBanned}. Reason: ${banReason || "none"} | Executed by Admin: ${req.user?.id}`
        }
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData
    });

    if (isVerified === true && !user.isVerified) {
      try {
        await trackTaskProgress(userId, "PROFILE_VERIFY", 1);
      } catch (taskErr) {
        console.error("Error triggering verification task:", taskErr);
      }
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    const userWithWallet = {
      ...updatedUser,
      wallet: wallet ? { freeBalance: wallet.freeBalance, cashBalance: wallet.cashBalance } : null
    };

    return res.json({ message: "تم تحديث بيانات المستخدم بنجاح.", user: userWithWallet });
  } catch (err: any) {
    console.error("Admin user update error:", err);
    return res.status(500).json({ error: "فشل تحديث بيانات المستخدم." });
  }
});

// Permanent Device / IP Fingerprint Ban
router.post("/users/:id/ban-device", requireSuperAdmin, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.params.id;
  const { reason } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    // Mark user as permanently banned
    await prisma.user.update({
      where: { id: userId },
      data: {
        isBanned: true,
        banExpiresAt: null,
        banReason: `DEVICE BAN: ${reason || "مخالفة الشروط"}`
      }
    });

    // Write a permanent device block signature in EventLogs to intercept GUEST/REGISTER
    await prisma.eventLog.create({
      data: {
        eventType: "DEVICE_PERMANENT_BAN",
        userId,
        message: `BANNED DEVICE ID: [${user.deviceId}] | Reason: ${reason || "Violating terms"} | Executed by SuperAdmin: ${req.user?.id}`
      }
    });

    return res.json({ message: "تم حظر الحساب والجهاز الخاص به نهائياً بنجاح." });
  } catch (err) {
    return res.status(500).json({ error: "فشل حظر الجهاز." });
  }
});

// Balance Adjustments (ADMIN allowed)
router.put("/users/:id/balance", async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.params.id;
  const { freeDelta, cashDelta, freeAmount, cashAmount, reason } = req.body;

  try {
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return res.status(404).json({ error: "User wallet not found." });

    const updated = await prisma.$transaction(async (tx: any) => {
      let finalFree = wallet.freeBalance;
      let finalCash = wallet.cashBalance;

      if (freeDelta !== undefined) {
        finalFree += parseFloat(freeDelta);
      } else if (freeAmount !== undefined) {
        finalFree = parseFloat(freeAmount);
      }

      if (cashDelta !== undefined) {
        finalCash += parseFloat(cashDelta);
      } else if (cashAmount !== undefined) {
        finalCash = parseFloat(cashAmount);
      }

      if (finalFree < 0) finalFree = 0;
      if (finalCash < 0) finalCash = 0;

      const updatedWallet = await tx.wallet.update({
        where: { userId },
        data: {
          freeBalance: finalFree,
          cashBalance: finalCash
        }
      });

      const freeDiff = updatedWallet.freeBalance - wallet.freeBalance;
      const cashDiff = updatedWallet.cashBalance - wallet.cashBalance;

      if (freeDiff !== 0) {
        await tx.transaction.create({
          data: {
            userId,
            amount: freeDiff,
            currency: "FREE",
            type: "ADMIN_ADJUSTMENT",
            description: `Admin balance adjustment. Reason: ${reason || "No reason specified"}`
          }
        });
      }

      if (cashDiff !== 0) {
        await tx.transaction.create({
          data: {
            userId,
            amount: cashDiff,
            currency: "CASH",
            type: "ADMIN_ADJUSTMENT",
            description: `Admin balance adjustment. Reason: ${reason || "No reason specified"}`
          }
        });
      }

      return updatedWallet;
    });

    await prisma.eventLog.create({
      data: {
        eventType: "WALLET_UPDATE",
        userId,
        message: `Admin ${req.user?.id} updated user balance. Free Change=${updated.freeBalance - wallet.freeBalance}, Cash Change=${updated.cashBalance - wallet.cashBalance} (New Free=${updated.freeBalance}, New Cash=${updated.cashBalance}). Reason: ${reason}`
      }
    });

    return res.json({ message: "Balances updated successfully.", wallet: updated });
  } catch (err) {
    console.error("Balance update error:", err);
    return res.status(500).json({ error: "Balance update failed." });
  }
});

// Retrieve User Logs (Activity & Admin actions)
router.get("/users/:id/logs", async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.params.id;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    const bets = await prisma.bet.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    const transactions = await prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    const deposits = await prisma.deposit.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    const withdrawals = await prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    const adminLogs = await prisma.eventLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100
    });

    // Compile activity logs
    const activityLogs: any[] = [];

    bets.forEach((b: any) => {
      activityLogs.push({
        type: "BET",
        message: `مراهنة بمبلغ ${b.amount} ${b.currency} على الصندوق ${b.boxIndex} (الحالة: ${b.status}، الفوز: ${b.winAmount})`,
        date: b.createdAt
      });
    });

    deposits.forEach((d: any) => {
      activityLogs.push({
        type: "DEPOSIT",
        message: `طلب شحن بقيمة ${d.amount} CASH (الحالة: ${d.status})`,
        date: d.createdAt
      });
    });

    withdrawals.forEach((w: any) => {
      activityLogs.push({
        type: "WITHDRAWAL",
        message: `طلب سحب بقيمة ${w.amount} CASH (الحالة: ${w.status})`,
        date: w.createdAt
      });
    });

    transactions.forEach((t: any) => {
      if (t.type === "BET_PLACE" || t.type === "BET_WIN") return;
      activityLogs.push({
        type: t.type,
        message: `${t.description} (${t.amount > 0 ? "+" : ""}${t.amount} ${t.currency})`,
        date: t.createdAt
      });
    });

    // Sort activity logs by date desc
    activityLogs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Compile admin actions
    const adminActions = adminLogs.map((log: any) => ({
      type: log.eventType,
      message: log.message,
      date: log.createdAt
    }));

    return res.json({
      activityLogs: activityLogs.slice(0, 100),
      adminActions
    });
  } catch (err) {
    console.error("Failed to load user logs:", err);
    return res.status(500).json({ error: "Failed to load user logs." });
  }
});

// Delete user account permanently (SuperAdmin only)
router.delete("/users/:id", requireSuperAdmin, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const userId = req.params.id;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    await prisma.user.delete({
      where: { id: userId }
    });

    await prisma.eventLog.create({
      data: {
        eventType: "ADMIN_DELETE_USER",
        message: `PERMANENT PURGE: User [Username: ${user.username}, PublicID: ${user.publicId}, Email: ${user.email || 'N/A'}, DeviceID: ${user.deviceId}] was permanently deleted by SuperAdmin: ${req.user?.id}`
      }
    });

    return res.json({ message: "تم حذف حساب المستخدم نهائياً من قاعدة البيانات بنجاح." });
  } catch (err) {
    console.error("Failed to purge user:", err);
    return res.status(500).json({ error: "فشل حذف حساب المستخدم من قاعدة البيانات." });
  }
});


// 3. Deposit Approval Queue
router.get("/deposits", async (req, res) => {
  try {
    const deposits = await prisma.deposit.findMany({
      include: { user: true },
      orderBy: { createdAt: "desc" }
    });
    return res.json({ deposits });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load deposits queue." });
  }
});

router.post("/deposits/:id/approve", async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const depositId = req.params.id;
  const { transactionRef } = req.body;

  try {
    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
    if (deposit.status !== "PENDING") {
      return res.status(400).json({ error: "Deposit is already processed." });
    }

    await prisma.$transaction(async (tx) => {
      // Approve deposit request
      await tx.deposit.update({
        where: { id: depositId },
        data: {
          status: "APPROVED",
          transactionRef,
          updatedAt: new Date()
        }
      });

      // Credit wallet
      const wallet = await tx.wallet.findUnique({ where: { userId: deposit.userId } });
      if (wallet) {
        await tx.wallet.update({
          where: { userId: deposit.userId },
          data: { cashBalance: wallet.cashBalance + deposit.amount }
        });
      }

      // Add to transaction logs
      await tx.transaction.create({
        data: {
          userId: deposit.userId,
          amount: deposit.amount,
          currency: "CASH",
          type: "DEPOSIT",
          description: `Deposit request approved (Ref: ${transactionRef || "N/A"})`
        }
      });

      // Task triggers run after transaction commits
    });

    // ─── TASK SYSTEM TRIGGERS ──────────────────────────────────────────────
    try {
      await trackTaskProgress(deposit.userId, "DEPOSIT", 1);
      await trackTaskProgress(deposit.userId, "FIRST_DEPOSIT", 1);
      await trackTaskProgress(deposit.userId, "DEPOSIT_TOTAL_AMOUNT", Math.round(deposit.amount));
    } catch (taskErr) {
      console.error("Error updating tasks on deposit approval:", taskErr);
    }

    await logEvent({
      eventType: EventType.SYSTEM_ALERT,
      message: `Deposit of ${deposit.amount} approved for user ${deposit.userId}`
    });

    return res.json({ message: "Deposit approved." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Approval transaction failed." });
  }
});

router.post("/deposits/:id/reject", async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const depositId = req.params.id;
  const { rejectionReason } = req.body;

  try {
    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
    if (deposit.status !== "PENDING") {
      return res.status(400).json({ error: "Deposit is already processed." });
    }

    await prisma.deposit.update({
      where: { id: depositId },
      data: {
        status: "REJECTED",
        rejectionReason,
        updatedAt: new Date()
      }
    });

    return res.json({ message: "Deposit request rejected." });
  } catch (err) {
    return res.status(500).json({ error: "Rejection failed." });
  }
});

// 4. Withdrawal Approval Queue
router.get("/withdrawals", async (req, res) => {
  try {
    const withdrawals = await prisma.withdrawal.findMany({
      include: { user: true },
      orderBy: { createdAt: "desc" }
    });
    return res.json({ withdrawals });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load withdrawals." });
  }
});

router.post("/withdrawals/:id/approve", async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const withdrawalId = req.params.id;
  const { transactionRef } = req.body;

  try {
    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) return res.status(404).json({ error: "Withdrawal not found." });
    if (withdrawal.status !== "PENDING") {
      return res.status(400).json({ error: "Withdrawal is already processed." });
    }

    await prisma.$transaction(async (tx) => {
      // Update status
      await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: "APPROVED",
          transactionRef,
          updatedAt: new Date()
        }
      });
    });

    await logEvent({
      eventType: EventType.SYSTEM_ALERT,
      message: `Withdrawal of ${withdrawal.amount} approved for user ${withdrawal.userId}`
    });

    return res.json({ message: "Withdrawal approved." });
  } catch (err) {
    return res.status(500).json({ error: "Approval failed." });
  }
});

router.post("/withdrawals/:id/reject", async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const withdrawalId = req.params.id;
  const { rejectionReason } = req.body;

  try {
    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) return res.status(404).json({ error: "Withdrawal not found." });
    if (withdrawal.status !== "PENDING") {
      return res.status(400).json({ error: "Withdrawal is already processed." });
    }

    // Refund player cash wallet since deduction happened on withdrawal request creation
    await prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: "REJECTED",
          rejectionReason,
          updatedAt: new Date()
        }
      });

      const wallet = await tx.wallet.findUnique({ where: { userId: withdrawal.userId } });
      if (wallet) {
        await tx.wallet.update({
          where: { userId: withdrawal.userId },
          data: { cashBalance: wallet.cashBalance + withdrawal.amount }
        });
      }

      await tx.transaction.create({
        data: {
          userId: withdrawal.userId,
          amount: withdrawal.amount,
          currency: "CASH",
          type: "BET_REFUND",
          description: `Withdrawal request rejected. Refunding ${withdrawal.amount}`
        }
      });
    });

    return res.json({ message: "Withdrawal request rejected and refunded." });
  } catch (err) {
    return res.status(500).json({ error: "Rejection failed." });
  }
});

// 5. Game Override Results
router.post("/override", requireSuperAdmin, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const { boxIndex, reason } = req.body;
  if (boxIndex === undefined || boxIndex < 0 || boxIndex > 7) {
    return res.status(400).json({ error: "Provide a valid boxIndex (0 to 7)." });
  }
  if (!reason) {
    return res.status(400).json({ error: "Override reason is mandatory." });
  }

  try {
    gameEngine.setOverride(boxIndex, req.user!.id, reason);
    return res.json({ message: `Override successful. Box ${boxIndex} forced as winning result.` });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// 6. Config CRUD
router.get("/config", async (req, res) => {
  try {
    const config = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    return res.json({ config });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch config." });
  }
});

router.put("/config", requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const {
    minBet,
    maxBet,
    roundDurationBetting,
    roundDurationCalcul,
    roundDurationReveal,
    isFreeEnabled,
    isCashEnabled,
    historyLength,
    isMaintenanceMode,
    maintenanceMessage,
    inviteRewardInviter,
    inviteRewardInvitee,
    dailyInviteLimit,
    isReferralActive
  } = req.body;

  try {
    const updated = await prisma.systemConfig.update({
      where: { id: "singleton" },
      data: {
        minBet,
        maxBet,
        roundDurationBetting,
        roundDurationCalcul,
        roundDurationReveal,
        isFreeEnabled,
        isCashEnabled,
        historyLength,
        isMaintenanceMode,
        maintenanceMessage,
        inviteRewardInviter,
        inviteRewardInvitee,
        dailyInviteLimit,
        isReferralActive
      }
    });

    await logEvent({
      eventType: EventType.SYSTEM_ALERT,
      message: `System configurations updated by SuperAdmin ${req.user?.id}`
    });

    return res.json({ message: "Configurations saved successfully.", config: updated });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save config." });
  }
});

// 7. House Pool logs
router.get("/pool/logs", async (req, res) => {
  try {
    const logs = await prisma.housePoolLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return res.json({ logs });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load pool logs." });
  }
});

// 8. Tasks admin CRUD (Daily, achievements, social)
router.get("/tasks", async (req, res) => {
  try {
    const tasks = await prisma.dailyTask.findMany();
    // Get completion counts group by taskId
    const completions = await prisma.taskProgress.groupBy({
      by: ["taskId"],
      _count: {
        id: true
      },
      where: {
        isCompleted: true
      }
    });

    const tasksWithCompletions = tasks.map(task => {
      const comp = completions.find(c => c.taskId === task.id);
      return {
        ...task,
        completionsCount: comp?._count.id || 0
      };
    });

    return res.json({ tasks: tasksWithCompletions });
  } catch (error) {
    console.error("Failed to load admin tasks:", error);
    return res.status(500).json({ error: "Failed to load tasks." });
  }
});

router.post("/tasks", requireSuperAdmin, async (req, res) => {
  const { key, title, description, goalCount, rewardAmount, rewardCurrency, type, actionType, linkUrl } = req.body;
  try {
    const task = await prisma.dailyTask.create({
      data: {
        key,
        title,
        description,
        goalCount: parseInt(goalCount),
        rewardAmount: parseFloat(rewardAmount),
        rewardCurrency,
        type: type || "DAILY",
        actionType: actionType || null,
        linkUrl: linkUrl || null
      }
    });
    return res.status(201).json({ task });
  } catch (err) {
    console.error("Create task error:", err);
    return res.status(500).json({ error: "Failed to create task." });
  }
});

router.put("/tasks/:id", requireSuperAdmin, async (req, res) => {
  const taskId = req.params.id;
  const { title, description, goalCount, rewardAmount, rewardCurrency, isEnabled, type, actionType, linkUrl } = req.body;
  try {
    const updateData: any = { title, description, rewardCurrency, isEnabled };
    if (goalCount !== undefined) updateData.goalCount = parseInt(goalCount);
    if (rewardAmount !== undefined) updateData.rewardAmount = parseFloat(rewardAmount);
    if (type !== undefined) updateData.type = type;
    if (actionType !== undefined) updateData.actionType = actionType || null;
    if (linkUrl !== undefined) updateData.linkUrl = linkUrl || null;

    const task = await prisma.dailyTask.update({
      where: { id: taskId },
      data: updateData
    });
    return res.json({ task });
  } catch (err) {
    console.error("Update task error:", err);
    return res.status(500).json({ error: "Failed to update task." });
  }
});

router.delete("/tasks/:id", requireSuperAdmin, async (req, res) => {
  const taskId = req.params.id;
  try {
    await prisma.dailyTask.delete({ where: { id: taskId } });
    return res.json({ message: "Task deleted successfully." });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete task." });
  }
});

// Reset task for all players
router.post("/tasks/:id/reset", async (req, res) => {
  const taskId = req.params.id;
  try {
    await prisma.taskProgress.deleteMany({
      where: { taskId }
    });
    return res.json({ message: "تم إعادة تعيين المهمة لجميع اللاعبين بنجاح." });
  } catch (error) {
    console.error("Failed to reset task:", error);
    return res.status(500).json({ error: "Failed to reset task." });
  }
});

// 9. Simulation Engine trigger (Direct run)
router.post("/simulation", async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const { numRounds = 50, initialPool = 100000, botCount = 10, betMin = 10, betMax = 100, currencyMode = "CASH" } = req.body;

  try {
    const { runSimulation } = require("../simulationEngine");
    const report = runSimulation({
      numRounds: parseInt(numRounds),
      initialPool: parseFloat(initialPool),
      botCount: parseInt(botCount),
      betMin: parseFloat(betMin),
      betMax: parseFloat(betMax),
      currencyMode
    });

    return res.json({ report });
  } catch (err) {
    console.error("Failed to run simulation:", err);
    return res.status(500).json({ error: "Failed to run simulation." });
  }
});

export default router;
