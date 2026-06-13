import { neon, neonConfig, Pool } from "@neondatabase/serverless";
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { v4 as uuidv4 } from "uuid";


// Lazy singleton - reads DATABASE_URL after dotenv.config() runs in server.ts
let _sql: ReturnType<typeof neon> | null = null;

export function getSql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL!;
    _sql = neon(url);
  }
  return _sql;
}

// ─── Prisma-compatible shim ─────────────────────────────────────────────────
// This gives existing code (gameEngine, routes) a familiar API while
// using Neon HTTP under the hood.

type WhereClause = Record<string, any>;
type DataClause  = Record<string, any>;

function buildWhereSQL(where: WhereClause): { clause: string; params: any[] } {
  const keys = Object.keys(where);
  const params: any[] = [];
  const parts = keys.map((k, i) => {
    params.push(where[k]);
    return `"${k}" = $${i + 1}`;
  });
  return { clause: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

function buildSetSQL(data: DataClause, offset = 0): { clause: string; params: any[] } {
  const keys = Object.keys(data);
  const params: any[] = [];
  const parts = keys.map((k, i) => {
    params.push(data[k]);
    return `"${k}" = $${i + 1 + offset}`;
  });
  return { clause: `SET ${parts.join(", ")}`, params };
}

function buildInsertSQL(table: string, data: DataClause): { sql: string; params: any[] } {
  const cols = Object.keys(data).map(k => `"${k}"`).join(", ");
  const params = Object.values(data);
  const vals = params.map((_, i) => `$${i + 1}`).join(", ");
  return { sql: `INSERT INTO "${table}" (${cols}) VALUES (${vals}) RETURNING *`, params };
}

// Helper to run raw SQL
async function runQuery(sql: string, params: any[] = []): Promise<any[]> {
  try {
    const result = await fetch(
      `https://${new URL(process.env.DATABASE_URL!).hostname}/sql`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Neon-Connection-String": process.env.DATABASE_URL!,
        },
        body: JSON.stringify({ query: sql, params }),
      }
    );
    const json = await result.json() as any;
    if (json.message) throw new Error(json.message);
    return json.rows ?? [];
  } catch (err: any) {
    throw err;
  }
}

// ─── Prisma-style model objects ──────────────────────────────────────────────

const makeModel = (table: string) => ({
  async findUnique({ where, include }: { where: WhereClause; include?: any }) {
    const { clause, params } = buildWhereSQL(where);
    const rows = await runQuery(`SELECT * FROM "${table}" ${clause} LIMIT 1`, params);
    return rows[0] ?? null;
  },
  async findFirst({ where, orderBy, take }: { where?: WhereClause; orderBy?: any; take?: number } = {}) {
    const { clause, params } = buildWhereSQL(where ?? {});
    const limit = take ? `LIMIT ${take}` : "LIMIT 1";
    const rows = await runQuery(`SELECT * FROM "${table}" ${clause} ${limit}`, params);
    return rows[0] ?? null;
  },
  async findMany({ where, orderBy, take, skip, select, include }: any = {}) {
    const { clause, params } = buildWhereSQL(where ?? {});
    let order = "";
    if (orderBy) {
      const [col, dir] = Object.entries(orderBy)[0] as [string, string];
      order = `ORDER BY "${col}" ${dir.toUpperCase()}`;
    }
    const limit = take ? `LIMIT ${take}` : "";
    const offset = skip ? `OFFSET ${skip}` : "";
    return await runQuery(`SELECT * FROM "${table}" ${clause} ${order} ${limit} ${offset}`, params);
  },
  async create({ data }: { data: DataClause }) {
    if (!data.id && table !== "EventLog") data = { id: uuidv4(), ...data };
    if (["Wallet", "Deposit", "Withdrawal"].includes(table) && !data.updatedAt) {
      data = { ...data, updatedAt: new Date() };
    }
    const { sql, params } = buildInsertSQL(table, data);
    const rows = await runQuery(sql, params);
    return rows[0];
  },
  async update({ where, data }: { where: WhereClause; data: DataClause }) {
    if (["Wallet", "Deposit", "Withdrawal"].includes(table) && !data.updatedAt) {
      data = { ...data, updatedAt: new Date() };
    }
    const { clause: whereClause, params: whereParams } = buildWhereSQL(where);
    const { clause: setClause, params: setParams } = buildSetSQL(data, whereParams.length);
    const sql = `UPDATE "${table}" ${setClause} ${whereClause} RETURNING *`;
    const rows = await runQuery(sql, [...whereParams, ...setParams]);
    return rows[0];
  },
  async updateMany({ where, data }: { where?: WhereClause; data: DataClause }) {
    const { clause, params: whereParams } = buildWhereSQL(where ?? {});
    const { clause: setClause, params: setParams } = buildSetSQL(data, whereParams.length);
    const sql = `UPDATE "${table}" ${setClause} ${clause}`;
    await runQuery(sql, [...whereParams, ...setParams]);
    return { count: 1 };
  },
  async upsert({ where, create, update }: { where: WhereClause; create: DataClause; update: DataClause }) {
    const existing = await this.findUnique({ where });
    if (existing) return this.update({ where, data: update });
    return this.create({ data: create });
  },
  async delete({ where }: { where: WhereClause }) {
    const { clause, params } = buildWhereSQL(where);
    const rows = await runQuery(`DELETE FROM "${table}" ${clause} RETURNING *`, params);
    return rows[0];
  },
  async deleteMany({ where }: { where?: WhereClause } = {}) {
    const { clause, params } = buildWhereSQL(where ?? {});
    await runQuery(`DELETE FROM "${table}" ${clause}`, params);
    return { count: 1 };
  },
  async count({ where }: { where?: WhereClause } = {}) {
    const { clause, params } = buildWhereSQL(where ?? {});
    const rows = await runQuery(`SELECT COUNT(*) as count FROM "${table}" ${clause}`, params);
    return parseInt(rows[0]?.count ?? "0");
  },
  async aggregate({ where, _sum, _avg, _count }: any = {}) {
    const { clause, params } = buildWhereSQL(where ?? {});
    const rows = await runQuery(`SELECT * FROM "${table}" ${clause}`, params);
    return { _count: rows.length };
  },
  async groupBy({ by, _sum, where, orderBy }: any = {}) {
    const { clause, params } = buildWhereSQL(where ?? {});
    const groupCol = Array.isArray(by) ? by[0] : by;
    const rows = await runQuery(`SELECT "${groupCol}", SUM("amount") as "_sum" FROM "${table}" ${clause} GROUP BY "${groupCol}"`, params);
    return rows;
  },
});

// ─── The `prisma` export ─────────────────────────────────────────────────────
export const prisma = {
  user:                  makeModel("User"),
  wallet:                makeModel("Wallet"),
  round:                 makeModel("Round"),
  bet:                   makeModel("Bet"),
  transaction:           makeModel("Transaction"),
  deposit:               makeModel("Deposit"),
  withdrawal:            makeModel("Withdrawal"),
  referral:              makeModel("Referral"),
  dailyTask:             makeModel("DailyTask"),
  taskProgress:          makeModel("TaskProgress"),
  systemConfig:          makeModel("SystemConfig"),
  housePool:             makeModel("HousePool"),
  housePoolLog:          makeModel("HousePoolLog"),
  pushNotificationToken: makeModel("PushNotificationToken"),
  eventLog:              makeModel("EventLog"),
  roundSnapshot:         makeModel("RoundSnapshot"),
  $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.reduce((acc, s, i) => acc + s + (values[i] !== undefined ? `$${i + 1}` : ""), "");
    return runQuery(sql, values);
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.reduce((acc, s, i) => acc + s + (values[i] !== undefined ? `$${i + 1}` : ""), "");
    return runQuery(sql, values);
  },
  $transaction: async (ops: any) => {
    if (typeof ops === "function") {
      // Execute transaction callback with prisma instance itself as mock transaction context
      return await ops(prisma);
    }
    const results: any[] = [];
    for (const op of ops) results.push(await op);
    return results;
  },
  $disconnect: async () => {},
} as any;

// ─── Seed / Initialize ───────────────────────────────────────────────────────
export async function initializeDatabase() {
  try {
    console.log("🔄 Initializing database via Neon HTTP...");

    // SystemConfig
    const configs = await runQuery(`SELECT id FROM "SystemConfig" WHERE id = 'singleton' LIMIT 1`);
    if (configs.length === 0) {
      await runQuery(
        `INSERT INTO "SystemConfig" (id,"minBet","maxBet","roundDurationBetting","roundDurationCalcul","roundDurationReveal","isFreeEnabled","isCashEnabled","historyLength","isMaintenanceMode","inviteRewardInviter","inviteRewardInvitee","dailyInviteLimit","isReferralActive")
         VALUES ('singleton',10,10000,25,10,5,true,true,20,false,500,200,5,true)
         ON CONFLICT (id) DO UPDATE SET "roundDurationBetting"=25,"roundDurationCalcul"=10,"roundDurationReveal"=5`
      );
      console.log("✅ SystemConfig seeded.");
    } else {
      await runQuery(`UPDATE "SystemConfig" SET "roundDurationBetting"=25,"roundDurationCalcul"=10,"roundDurationReveal"=5 WHERE id='singleton'`);
      console.log("✅ SystemConfig updated.");
    }

    // HousePools
    await runQuery(`INSERT INTO "HousePool" (id,type,balance,"updatedAt") VALUES ($1,'FREE',10000000,NOW()) ON CONFLICT (type) DO NOTHING`, [uuidv4()]);
    await runQuery(`INSERT INTO "HousePool" (id,type,balance,"updatedAt") VALUES ($1,'CASH',100000,NOW()) ON CONFLICT (type) DO NOTHING`, [uuidv4()]);
    console.log("✅ HousePools seeded.");

    // Daily Tasks
    const tasks = [
      { key: "daily_login",    title: "Daily Login",      description: "Log in to the game today.",            goalCount: 1,  rewardAmount: 100,  rewardCurrency: "FREE" },
      { key: "play_5_rounds",  title: "Play 5 Rounds",    description: "Participate in 5 game rounds.",        goalCount: 5,  rewardAmount: 300,  rewardCurrency: "FREE" },
      { key: "play_20_rounds", title: "Play 20 Rounds",   description: "Participate in 20 game rounds.",       goalCount: 20, rewardAmount: 1000, rewardCurrency: "FREE" },
      { key: "invite_friend",  title: "Invite a Friend",  description: "Invite a friend using your referral.", goalCount: 1,  rewardAmount: 500,  rewardCurrency: "FREE" },
      { key: "first_deposit",  title: "First Charge",     description: "Complete your first deposit.",         goalCount: 1,  rewardAmount: 50,   rewardCurrency: "CASH" },
    ];
    for (const t of tasks) {
      await runQuery(
        `INSERT INTO "DailyTask" (id,key,title,description,"goalCount","rewardAmount","rewardCurrency","isEnabled")
         VALUES ($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT (key) DO NOTHING`,
        [uuidv4(), t.key, t.title, t.description, t.goalCount, t.rewardAmount, t.rewardCurrency]
      );
    }
    console.log("✅ DailyTasks seeded.");

    // SuperAdmin
    const admins = await runQuery(`SELECT id FROM "User" WHERE role='SUPERADMIN' LIMIT 1`);
    if (admins.length === 0) {
      const bcrypt = require("bcrypt");
      const passwordHash = await bcrypt.hash("adminpassword", 10);
      const adminId = uuidv4();
      await runQuery(
        `INSERT INTO "User" (id,"publicId",email,"passwordHash",username,"displayNickname",role,"deviceId","referralCode") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [adminId, "10000000", "admin@greedboxes.com", passwordHash, "admin", "SuperAdmin", "SUPERADMIN", "server_console", "ADMIN1"]
      );
      await runQuery(
        `INSERT INTO "Wallet" (id,"userId","freeBalance","cashBalance","updatedAt") VALUES ($1,$2,$3,$4,NOW())`,
        [uuidv4(), adminId, 1000000.0, 100000.0]
      );
      console.log("✅ SuperAdmin created.");
    }

    // Reset all test wallets
    await runQuery(`UPDATE "Wallet" SET "freeBalance"=1000000,"cashBalance"=100000,"updatedAt"=NOW()`);
    console.log("✅ Test wallets reset.");

    console.log("🎉 Database initialization complete!");
  } catch (error) {
    console.error("❌ Error during database initialization:", error);
    throw error;
  }
}


// Force all Pool queries through HTTPS (port 443) - avoids IPv6 TCP port 5432 issues
neonConfig.poolQueryViaFetch = true;
// Set the fetch endpoint to use HTTPS SQL API
neonConfig.fetchEndpoint = (host: string) =>
  `https://${host}/sql`;

