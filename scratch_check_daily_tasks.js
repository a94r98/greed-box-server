const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tasks = await prisma.dailyTask.findMany({
    where: { type: "DAILY" }
  });
  console.log(JSON.stringify(tasks.map(t => t.key), null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
