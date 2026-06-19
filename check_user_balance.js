require('dotenv').config();
const { prisma } = require('./dist/db');

async function check() {
  const username = "guest_15210379";
  try {
    const user = await prisma.user.findFirst({
      where: { username }
    });
    if (!user) {
      console.log(`User ${username} not found.`);
      return;
    }
    console.log(`User found: ${user.username} (ID: ${user.id})`);
    const wallet = await prisma.wallet.findUnique({
      where: { userId: user.id }
    });
    if (!wallet) {
      console.log("Wallet not found.");
      return;
    }
    console.log(`Wallet Balances:`);
    console.log(`  freeBalance (Diamonds): ${wallet.freeBalance}`);
    console.log(`  cashBalance (Coins):    ${wallet.cashBalance}`);
  } catch (err) {
    console.error("Error checking balance:", err);
  }
}

check();
