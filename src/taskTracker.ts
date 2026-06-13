import { prisma } from "./db";

export async function trackTaskProgress(userId: string, actionType: string, incrementBy: number = 1, forceCount?: number) {
  try {
    const tasks = await prisma.dailyTask.findMany({
      where: { actionType, isEnabled: true }
    });

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    for (const task of tasks) {
      let progress = await prisma.taskProgress.findUnique({
        where: { userId_taskId: { userId, taskId: task.id } }
      });

      let currentCount = 0;
      let isCompleted = false;
      let claimedAt = null;
      let progressId = "";

      if (!progress) {
        const initialCount = forceCount !== undefined ? forceCount : incrementBy;
        const finalCount = Math.min(initialCount, task.goalCount);
        const comp = finalCount >= task.goalCount;
        
        const newProgress = await prisma.taskProgress.create({
          data: {
            userId,
            taskId: task.id,
            count: finalCount,
            isCompleted: comp
          }
        });
        currentCount = finalCount;
        isCompleted = comp;
        progressId = newProgress.id;
      } else {
        progressId = progress.id;
        currentCount = progress.count;
        isCompleted = progress.isCompleted;
        claimedAt = progress.claimedAt;

        if (task.type === "DAILY") {
          const progressDate = new Date(progress.updatedAt);
          if (progressDate < todayStart) {
            currentCount = 0;
            isCompleted = false;
            claimedAt = null;
          }
        }

        let newCount = forceCount !== undefined ? forceCount : (currentCount + incrementBy);
        if (newCount > task.goalCount) {
          newCount = task.goalCount;
        }

        const newIsCompleted = newCount >= task.goalCount;

        await prisma.taskProgress.update({
          where: { id: progressId },
          data: {
            count: newCount,
            isCompleted: newIsCompleted,
            claimedAt: newIsCompleted ? claimedAt : null
          }
        });
        currentCount = newCount;
        isCompleted = newIsCompleted;
      }

      // Automation: If the task is a social task and it became completed, check if all 5 are completed to complete SOCIAL_JOIN_ALL
      const socialKeys = ["social_facebook", "social_instagram", "social_tiktok", "social_whatsapp", "social_telegram"];
      if (socialKeys.includes(task.key) && isCompleted) {
        const otherSocials = await prisma.dailyTask.findMany({
          where: {
            key: { in: socialKeys },
            isEnabled: true
          }
        });
        const otherProgress = await prisma.taskProgress.findMany({
          where: { userId }
        });

        let allSocialsCompleted = true;
        for (const s of otherSocials) {
          if (s.key === task.key) continue; // we know this one is completed
          const p = otherProgress.find(op => op.taskId === s.id);
          if (!p || !p.isCompleted) {
            allSocialsCompleted = false;
            break;
          }
        }

        if (allSocialsCompleted) {
          await trackTaskProgress(userId, "SOCIAL_JOIN_ALL", 1);
        }
      }
    }
  } catch (error) {
    console.error(`Error tracking task progress for user ${userId}, action ${actionType}:`, error);
  }
}
