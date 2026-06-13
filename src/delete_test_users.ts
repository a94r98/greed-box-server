import dotenv from "dotenv";
dotenv.config();
import { prisma } from "./db";

async function main() {
  console.log("Starting deletion of test users...");
  try {
    // Fetch all users to filter them in JavaScript to bypass shim limitations
    const allUsers = await prisma.user.findMany();
    console.log(`Total users in database: ${allUsers.length}`);

    const usersToDelete = allUsers.filter(u => 
      u.role !== "SUPERADMIN" && 
      u.role !== "ADMIN" && 
      u.username !== "admin"
    );

    console.log(`Found ${usersToDelete.length} test users to delete.`);

    for (const user of usersToDelete) {
      console.log(`Deleting user: ${user.username} (ID: ${user.publicId})`);

      // Delete related records via simple equality where clause
      await prisma.referral.deleteMany({ where: { inviterId: user.id } });
      await prisma.referral.deleteMany({ where: { inviteeId: user.id } });
      await prisma.wallet.deleteMany({ where: { userId: user.id } });
      await prisma.deposit.deleteMany({ where: { userId: user.id } });
      await prisma.withdrawal.deleteMany({ where: { userId: user.id } });
      await prisma.bet.deleteMany({ where: { userId: user.id } });
      await prisma.eventLog.deleteMany({ where: { userId: user.id } });
      await prisma.taskProgress.deleteMany({ where: { userId: user.id } });

      // Delete the user
      await prisma.user.delete({ where: { id: user.id } });
      console.log(`Deleted user ${user.username} successfully.`);
    }

    console.log("Cleanup finished.");
  } catch (err) {
    console.error("Error deleting users:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
