const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Testing Prisma connection...");
  try {
    const res = await prisma.$queryRaw`SELECT 1`;
    console.log("SUCCESS! Result:", res);
  } catch (err) {
    console.error("PRISMA ERROR:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
