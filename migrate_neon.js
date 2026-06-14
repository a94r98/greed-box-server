/**
 * Migration script using Neon serverless to create all database tables.
 * This is used because prisma db push has TCP/IPv6 issues on this network.
 */

const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  console.log("🔄 Creating database tables via Neon HTTP...");
  try {
    // Create all tables based on prisma schema
    await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;

    await sql`
      CREATE TABLE IF NOT EXISTS "User" (
        "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "username"        TEXT,
        "email"           TEXT UNIQUE,
        "passwordHash"    TEXT,
        "role"            TEXT NOT NULL DEFAULT 'USER',
        "deviceId"        TEXT NOT NULL,
        "referralCode"    TEXT NOT NULL UNIQUE,
        "referredByCode"  TEXT,
        "avatar"          TEXT NOT NULL DEFAULT 'avatar_1',
        "bio"             TEXT,
        "whatsapp"        TEXT,
        "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "roundsPlayed"    INTEGER NOT NULL DEFAULT 0,
        "roundsWon"       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY ("id")
      )
    `;
    console.log("✅ User table");

    await sql`
      CREATE TABLE IF NOT EXISTS "Wallet" (
        "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"      TEXT NOT NULL UNIQUE,
        "freeBalance" DOUBLE PRECISION NOT NULL DEFAULT 1000.0,
        "cashBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ Wallet table");

    await sql`
      CREATE TABLE IF NOT EXISTS "Round" (
        "id"                TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "status"            TEXT NOT NULL DEFAULT 'BETTING',
        "currencyMode"      TEXT NOT NULL DEFAULT 'FREE_ONLY',
        "winningBox"        INTEGER,
        "winningMultiplier" DOUBLE PRECISION,
        "totalBetsFree"     DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        "totalBetsCash"     DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        "totalPayoutFree"   DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        "totalPayoutCash"   DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        "startAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "sequenceNumber"    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY ("id")
      )
    `;
    console.log("✅ Round table");

    await sql`
      CREATE TABLE IF NOT EXISTS "Bet" (
        "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"      TEXT NOT NULL,
        "roundId"     TEXT NOT NULL,
        "clientBetId" TEXT NOT NULL,
        "boxIndex"    INTEGER NOT NULL,
        "amount"      DOUBLE PRECISION NOT NULL,
        "currency"    TEXT NOT NULL,
        "status"      TEXT NOT NULL DEFAULT 'PENDING',
        "winAmount"   DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        UNIQUE ("userId", "roundId", "clientBetId"),
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
        FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ Bet table");

    await sql`
      CREATE TABLE IF NOT EXISTS "Transaction" (
        "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"      TEXT NOT NULL,
        "amount"      DOUBLE PRECISION NOT NULL,
        "currency"    TEXT NOT NULL,
        "type"        TEXT NOT NULL,
        "description" TEXT NOT NULL,
        "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ Transaction table");

    await sql`
      CREATE TABLE IF NOT EXISTS "Deposit" (
        "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"          TEXT NOT NULL,
        "amount"          DOUBLE PRECISION NOT NULL,
        "status"          TEXT NOT NULL DEFAULT 'PENDING',
        "transactionRef"  TEXT,
        "rejectionReason" TEXT,
        "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ Deposit table");

    await sql`
      CREATE TABLE IF NOT EXISTS "Withdrawal" (
        "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"          TEXT NOT NULL,
        "amount"          DOUBLE PRECISION NOT NULL,
        "status"          TEXT NOT NULL DEFAULT 'PENDING',
        "transactionRef"  TEXT,
        "rejectionReason" TEXT,
        "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ Withdrawal table");

    await sql`
      CREATE TABLE IF NOT EXISTS "Referral" (
        "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "inviterId" TEXT NOT NULL,
        "inviteeId" TEXT NOT NULL UNIQUE,
        "bonusPaid" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE,
        FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ Referral table");

    await sql`
      CREATE TABLE IF NOT EXISTS "DailyTask" (
        "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "key"            TEXT NOT NULL UNIQUE,
        "title"          TEXT NOT NULL,
        "description"    TEXT NOT NULL,
        "goalCount"      INTEGER NOT NULL,
        "rewardAmount"   DOUBLE PRECISION NOT NULL,
        "rewardCurrency" TEXT NOT NULL,
        "isEnabled"      BOOLEAN NOT NULL DEFAULT true,
        PRIMARY KEY ("id")
      )
    `;
    console.log("✅ DailyTask table");

    await sql`
      CREATE TABLE IF NOT EXISTS "TaskProgress" (
        "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"      TEXT NOT NULL,
        "taskId"      TEXT NOT NULL,
        "count"       INTEGER NOT NULL DEFAULT 0,
        "isCompleted" BOOLEAN NOT NULL DEFAULT false,
        "claimedAt"   TIMESTAMP(3),
        "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        UNIQUE ("userId", "taskId"),
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
        FOREIGN KEY ("taskId") REFERENCES "DailyTask"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ TaskProgress table");

    await sql`
      CREATE TABLE IF NOT EXISTS "SystemConfig" (
        "id"                    TEXT NOT NULL DEFAULT 'singleton',
        "minBet"                DOUBLE PRECISION NOT NULL DEFAULT 10.0,
        "maxBet"                DOUBLE PRECISION NOT NULL DEFAULT 10000.0,
        "roundDurationBetting"  INTEGER NOT NULL DEFAULT 20,
        "roundDurationCalcul"   INTEGER NOT NULL DEFAULT 3,
        "roundDurationReveal"   INTEGER NOT NULL DEFAULT 5,
        "isFreeEnabled"         BOOLEAN NOT NULL DEFAULT true,
        "isCashEnabled"         BOOLEAN NOT NULL DEFAULT true,
        "historyLength"         INTEGER NOT NULL DEFAULT 20,
        "isMaintenanceMode"     BOOLEAN NOT NULL DEFAULT false,
        "maintenanceMessage"    TEXT NOT NULL DEFAULT 'The game is currently under maintenance. Please try again later.',
        "inviteRewardInviter"   DOUBLE PRECISION NOT NULL DEFAULT 500.0,
        "inviteRewardInvitee"   DOUBLE PRECISION NOT NULL DEFAULT 200.0,
        "dailyInviteLimit"      INTEGER NOT NULL DEFAULT 5,
        "isReferralActive"      BOOLEAN NOT NULL DEFAULT true,
        "supportTelegram"       TEXT NOT NULL DEFAULT '',
        "supportWhatsApp"       TEXT NOT NULL DEFAULT '',
        PRIMARY KEY ("id")
      )
    `;
    console.log("✅ SystemConfig table");

    // Upgrade SystemConfig if columns do not exist
    try {
      await sql`ALTER TABLE "SystemConfig" ADD COLUMN IF NOT EXISTS "supportTelegram" TEXT DEFAULT ''`;
      await sql`ALTER TABLE "SystemConfig" ADD COLUMN IF NOT EXISTS "supportWhatsApp" TEXT DEFAULT ''`;
      console.log("✅ Upgraded SystemConfig table columns");
    } catch (configErr) {
      console.log("⚠️ Config table upgrade notice:", configErr.message);
    }

    // Upgrade User if columns do not exist
    try {
      await sql`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bio" TEXT DEFAULT ''`;
      await sql`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "whatsapp" TEXT DEFAULT ''`;
      console.log("✅ Upgraded User table columns (bio, whatsapp)");
    } catch (userErr) {
      console.log("⚠️ User table upgrade notice:", userErr.message);
    }

    await sql`
      CREATE TABLE IF NOT EXISTS "HousePool" (
        "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "type"      TEXT NOT NULL UNIQUE,
        "balance"   DOUBLE PRECISION NOT NULL DEFAULT 1000000.0,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id")
      )
    `;
    console.log("✅ HousePool table");

    await sql`
      CREATE TABLE IF NOT EXISTS "HousePoolLog" (
        "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "poolType"     TEXT NOT NULL,
        "amountChange" DOUBLE PRECISION NOT NULL,
        "type"         TEXT NOT NULL,
        "referenceId"  TEXT,
        "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id")
      )
    `;
    console.log("✅ HousePoolLog table");

    await sql`
      CREATE TABLE IF NOT EXISTS "PushNotificationToken" (
        "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"    TEXT NOT NULL,
        "token"     TEXT NOT NULL UNIQUE,
        "platform"  TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ PushNotificationToken table");

    await sql`
      CREATE SEQUENCE IF NOT EXISTS "EventLog_globalEventId_seq"
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS "EventLog" (
        "globalEventId" INTEGER NOT NULL DEFAULT nextval('"EventLog_globalEventId_seq"'),
        "roundId"       TEXT,
        "requestId"     TEXT,
        "eventType"     TEXT NOT NULL,
        "userId"        TEXT,
        "message"       TEXT NOT NULL,
        "sequenceNumber" INTEGER NOT NULL DEFAULT 0,
        "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("globalEventId"),
        FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE SET NULL
      )
    `;
    console.log("✅ EventLog table");

    await sql`
      CREATE TABLE IF NOT EXISTS "SupportMessage" (
        "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"    TEXT NOT NULL,
        "sender"    TEXT NOT NULL,
        "message"   TEXT,
        "imageUrl"  TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ SupportMessage table");

    await sql`
      CREATE TABLE IF NOT EXISTS "RoundSnapshot" (
        "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "roundId"         TEXT NOT NULL,
        "poolFreeBalance" DOUBLE PRECISION NOT NULL,
        "poolCashBalance" DOUBLE PRECISION NOT NULL,
        "totalBetsFree"   DOUBLE PRECISION NOT NULL,
        "totalBetsCash"   DOUBLE PRECISION NOT NULL,
        "betsJson"        TEXT NOT NULL,
        "resultBox"       INTEGER NOT NULL,
        "isOverride"      BOOLEAN NOT NULL DEFAULT false,
        "overrideAdminId" TEXT,
        "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("id"),
        FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE CASCADE
      )
    `;
    console.log("✅ RoundSnapshot table");

    // Add _prisma_migrations table to avoid schema conflicts
    await sql`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id"                      VARCHAR(36) NOT NULL,
        "checksum"                VARCHAR(64) NOT NULL,
        "finished_at"             TIMESTAMPTZ,
        "migration_name"          VARCHAR(255) NOT NULL,
        "logs"                    TEXT,
        "rolled_back_at"          TIMESTAMPTZ,
        "started_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count"     INT NOT NULL DEFAULT 0,
        PRIMARY KEY ("id")
      )
    `;

    console.log("\n🎉 All tables created successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration error:", err.message);
    process.exit(1);
  }
}

migrate();
