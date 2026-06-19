require('dotenv').config();
const { prisma } = require('./dist/db');

async function list() {
  try {
    const users = await prisma.user.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' }
    });
    console.log("Recent users in database:");
    for (const u of users) {
      const w = await prisma.wallet.findUnique({ where: { userId: u.id } });
      console.log(`Username: ${u.username} | Nickname: ${u.displayNickname} | Created: ${u.createdAt}`);
      if (w) {
        console.log(`  Wallet: Diamonds=${w.freeBalance} | Coins=${w.cashBalance}`);
      } else {
        console.log("  No wallet found.");
      }
    }
  } catch (err) {
    console.error("Error listing users:", err);
  }
}

list();
