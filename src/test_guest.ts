import dotenv from "dotenv";
dotenv.config();
import { prisma } from "./db";

async function main() {
  console.log("Testing complete guest login logic...");
  const deviceId = "test_device_123456_" + Math.random().toString(36).substring(7);
  try {
    console.log(`DeviceId generated: ${deviceId}`);
    
    console.log("1. Checking permanently banned devices...");
    const banLogs = await prisma.eventLog.findMany({
      where: { eventType: "DEVICE_PERMANENT_BAN" }
    });
    const bannedDevice = banLogs.find((log: any) => log.message && log.message.includes(deviceId));
    console.log("Banned device status:", bannedDevice ? "BANNED" : "NOT BANNED");

    console.log("2. Checking existing user query...");
    let user = await prisma.user.findFirst({
      where: { deviceId, email: null }
    });
    console.log("User query finished. Found user:", user);

    console.log("3. Creating new user...");
    const existingAccountsCount = await prisma.user.count({
      where: { deviceId }
    });
    console.log(`Existing accounts count: ${existingAccountsCount}`);

    const referralCode = "REF_" + Math.random().toString(36).substring(2, 6).toUpperCase();
    const publicId = Math.floor(10000000 + mathRandom() * 90000000).toString();
    
    user = await prisma.user.create({
      data: {
        publicId,
        deviceId,
        role: "GUEST",
        referralCode,
        username: `guest_${publicId}`
      }
    });
    console.log("Created guest user successfully:", user);

    console.log("4. Creating wallet...");
    const wallet = await prisma.wallet.create({
      data: {
        userId: user.id,
        freeBalance: 1000.0,
        cashBalance: 0.0
      }
    });
    console.log("Created wallet successfully:", wallet);

    console.log("5. Creating event log...");
    const log = await prisma.eventLog.create({
      data: {
        eventType: "USER_REGISTER_GUEST",
        userId: user.id,
        message: `Registered guest account ${publicId} on device ${deviceId}`
      }
    });
    console.log("Created event log successfully:", log);
    
  } catch (err: any) {
    console.error("❌ Database Operation Failed with Error:", err);
    console.error("Stack trace:", err.stack);
  } finally {
    // Delete test records to keep DB clean
    await prisma.user.deleteMany({
      where: { deviceId: { startsWith: "test_device_123456" } } as any
    });
    await prisma.$disconnect();
  }
}

// Simple random generator
const mathRandom = Math.random;

main();
