const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tasks = await prisma.dailyTask.findMany({
    where: { type: "DAILY" },
    select: { key: true, actionType: true, goalCount: true }
  });
  console.log(JSON.stringify(tasks, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
