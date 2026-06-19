const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const otherDailyTasksCount = await prisma.dailyTask.count({
    where: {
      type: "DAILY",
      key: { not: "complete_all_daily" },
      isEnabled: true
    }
  });

  const updated = await prisma.dailyTask.updateMany({
    where: { key: "complete_all_daily" },
    data: { goalCount: otherDailyTasksCount }
  });
  
  const socialJoinAllUpdated = await prisma.dailyTask.updateMany({
    where: { key: "social_join_all" },
    data: { goalCount: 1 }
  });

  console.log(`Updated complete_all_daily goalCount to ${otherDailyTasksCount}`);
  console.log(`Updated social_join_all goalCount to 1`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
