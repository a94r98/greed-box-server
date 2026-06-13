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

    // Daily Tasks Seeding
    const tasks = [
      // 📅 Daily Tasks (DAILY) - 15 tasks
      { key: "daily_login",            title: "تسجيل الدخول اليومي",        description: "الدخول للتطبيق.",                           goalCount: 1,     rewardAmount: 500,   rewardCurrency: "FREE", type: "DAILY", actionType: "DAILY_LOGIN", linkUrl: null },
      { key: "play_3_rounds",          title: "العب 3 جولات",              description: "إكمال 3 جولات.",                             goalCount: 3,     rewardAmount: 1000,  rewardCurrency: "FREE", type: "DAILY", actionType: "PLAY_ROUNDS", linkUrl: null },
      { key: "play_10_rounds",         title: "العب 10 جولات",             description: "إكمال 10 جولات.",                            goalCount: 10,    rewardAmount: 2500,  rewardCurrency: "FREE", type: "DAILY", actionType: "PLAY_ROUNDS", linkUrl: null },
      { key: "bet_5k_coins",           title: "راهن 5,000 كونز",           description: "مجموع رهانات الكونزات المدفوعة.",            goalCount: 5000,  rewardAmount: 500,   rewardCurrency: "FREE", type: "DAILY", actionType: "BET_COINS", linkUrl: null },
      { key: "bet_25k_coins",          title: "راهن 25,000 كونز",          description: "مجموع رهانات الكونزات المدفوعة.",            goalCount: 25000, rewardAmount: 1500,  rewardCurrency: "FREE", type: "DAILY", actionType: "BET_COINS", linkUrl: null },
      { key: "win_1_round",            title: "اربح جولة واحدة",            description: "اربح جولة واحدة.",                           goalCount: 1,     rewardAmount: 750,   rewardCurrency: "FREE", type: "DAILY", actionType: "WIN_ROUNDS", linkUrl: null },
      { key: "win_5_rounds",           title: "اربح 5 جولات",              description: "اربح 5 جولات.",                             goalCount: 5,     rewardAmount: 2500,  rewardCurrency: "FREE", type: "DAILY", actionType: "WIN_ROUNDS", linkUrl: null },
      { key: "share_app_daily",        title: "شارك التطبيق مع صديق",       description: "شارك رابط التطبيق مع الأصدقاء.",             goalCount: 1,     rewardAmount: 500,   rewardCurrency: "FREE", type: "DAILY", actionType: "APP_SHARE", linkUrl: null },
      { key: "online_30_min",          title: "ابقَ متصلاً 30 دقيقة",       description: "ابقَ متصلاً بالتطبيق لمدة 30 دقيقة.",         goalCount: 30,    rewardAmount: 1000,  rewardCurrency: "FREE", type: "DAILY", actionType: "ONLINE_MINUTES", linkUrl: null },
      { key: "online_60_min",          title: "ابقَ متصلاً 60 دقيقة",       description: "ابقَ متصلاً بالتطبيق لمدة 60 دقيقة.",         goalCount: 60,    rewardAmount: 2000,  rewardCurrency: "FREE", type: "DAILY", actionType: "ONLINE_MINUTES", linkUrl: null },
      { key: "open_rankings_daily",    title: "ادخل قسم الترتيب",          description: "تصفح لوحة الصدارة اليوم.",                   goalCount: 1,     rewardAmount: 250,   rewardCurrency: "FREE", type: "DAILY", actionType: "OPEN_RANKINGS", linkUrl: null },
      { key: "invite_1_friend_daily",  title: "أرسل دعوة واحدة",           description: "ادعُ صديقاً للتسجيل في التطبيق.",             goalCount: 1,     rewardAmount: 1000,  rewardCurrency: "FREE", type: "DAILY", actionType: "INVITE_FRIEND", linkUrl: null },
      { key: "deposit_any_daily",      title: "اشحن أي مبلغ",              description: "قم بشحن أي رصيد.",                           goalCount: 1,     rewardAmount: 2000,  rewardCurrency: "FREE", type: "DAILY", actionType: "DEPOSIT", linkUrl: null },
      { key: "use_diamonds_once",      title: "استخدم الماسات مرة واحدة",   description: "قم بالمراهنة بالماسات مرة واحدة.",           goalCount: 1,     rewardAmount: 500,   rewardCurrency: "FREE", type: "DAILY", actionType: "USE_DIAMONDS", linkUrl: null },
      { key: "complete_all_daily",     title: "أكمل جميع المهام اليومية",    description: "صندوق مكافأة يومي لإكمال باقي المهام.",      goalCount: 14,    rewardAmount: 5000,  rewardCurrency: "FREE", type: "DAILY", actionType: "COMPLETE_ALL_DAILY", linkUrl: null },

      // 🎯 One-time Achievements (ONETIME) - 20 tasks
      { key: "create_account",         title: "إنشاء الحساب",              description: "أنشئ حساباً وقم بالتسجيل.",                 goalCount: 1,     rewardAmount: 2000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "CREATE_ACCOUNT", linkUrl: null },
      { key: "add_avatar",             title: "إضافة صورة شخصية",          description: "قم بتغيير صورتك الشخصية.",                   goalCount: 1,     rewardAmount: 1000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "PROFILE_AVATAR", linkUrl: null },
      { key: "add_email",              title: "إضافة البريد الإلكتروني",    description: "اربط بريدك الإلكتروني بالحساب.",             goalCount: 1,     rewardAmount: 1000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "PROFILE_EMAIL", linkUrl: null },
      { key: "verify_account",         title: "توثيق الحساب",              description: "قم بتوثيق حسابك رسمياً.",                   goalCount: 1,     rewardAmount: 2000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "PROFILE_VERIFY", linkUrl: null },
      { key: "first_bet",              title: "أول رهان",                  description: "قم بأول مراهنة لك بالكونزات.",               goalCount: 1,     rewardAmount: 1000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "FIRST_BET", linkUrl: null },
      { key: "first_win",              title: "أول فوز",                  description: "حقق أول فوز لك في جولة.",                    goalCount: 1,     rewardAmount: 1500,  rewardCurrency: "FREE", type: "ONETIME", actionType: "FIRST_WIN", linkUrl: null },
      { key: "play_50_rounds",         title: "لعب 50 جولة",               description: "إكمال لعب 50 جولة.",                         goalCount: 50,    rewardAmount: 5000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "PLAY_ROUNDS_TOTAL", linkUrl: null },
      { key: "play_100_rounds",        title: "لعب 100 جولة",              description: "إكمال لعب 100 جولة.",                        goalCount: 100,   rewardAmount: 10000, rewardCurrency: "FREE", type: "ONETIME", actionType: "PLAY_ROUNDS_TOTAL", linkUrl: null },
      { key: "play_500_rounds",        title: "لعب 500 جولة",              description: "إكمال لعب 500 جولة.",                        goalCount: 500,   rewardAmount: 50000, rewardCurrency: "FREE", type: "ONETIME", actionType: "PLAY_ROUNDS_TOTAL", linkUrl: null },
      { key: "first_deposit",          title: "شحن لأول مرة",              description: "قم بأول عملية شحن رصيد.",                     goalCount: 1,     rewardAmount: 3000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "FIRST_DEPOSIT", linkUrl: null },
      { key: "deposit_100k_coins_total",title: "شحن 100 ألف كونز إجمالي",    description: "قم بشحن 100,000 كونز إجمالياً.",              goalCount: 100000,rewardAmount: 5000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "DEPOSIT_TOTAL_AMOUNT", linkUrl: null },
      { key: "invite_first_friend",    title: "دعوة أول صديق",             description: "ادعُ أول صديق للتسجيل بالتطبيق.",            goalCount: 1,     rewardAmount: 2000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "INVITE_FRIENDS_TOTAL", linkUrl: null },
      { key: "invite_5_friends",       title: "دعوة 5 أصدقاء",             description: "ادعُ 5 أصدقاء للتسجيل بالتطبيق.",            goalCount: 5,     rewardAmount: 10000, rewardCurrency: "FREE", type: "ONETIME", actionType: "INVITE_FRIENDS_TOTAL", linkUrl: null },
      { key: "invite_10_friends",      title: "دعوة 10 أصدقاء",            description: "ادعُ 10 أصدقاء للتسجيل بالتطبيق.",           goalCount: 10,    rewardAmount: 25000, rewardCurrency: "FREE", type: "ONETIME", actionType: "INVITE_FRIENDS_TOTAL", linkUrl: null },
      { key: "reach_top_100",          title: "الوصول إلى قائمة أفضل 100 لاعب",description: "كن من بين أفضل 100 لاعب في الترتيب.",        goalCount: 1,     rewardAmount: 5000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "REACH_TOP_100", linkUrl: null },
      { key: "reach_top_50",           title: "الوصول إلى أفضل 50 لاعب",   description: "كن من بين أفضل 50 لاعب في الترتيب.",         goalCount: 1,     rewardAmount: 10000, rewardCurrency: "FREE", type: "ONETIME", actionType: "REACH_TOP_50", linkUrl: null },
      { key: "reach_top_10",           title: "الوصول إلى أفضل 10 لاعبين",  description: "كن من بين أفضل 10 لاعبين في الترتيب.",        goalCount: 1,     rewardAmount: 50000, rewardCurrency: "FREE", type: "ONETIME", actionType: "REACH_TOP_10", linkUrl: null },
      { key: "win_with_45x",           title: "الفوز بجولة ×45",            description: "احصل على فوز بمضاعف x45.",                   goalCount: 1,     rewardAmount: 15000, rewardCurrency: "FREE", type: "ONETIME", actionType: "WIN_WITH_45X", linkUrl: null },
      { key: "win_100k_coins_total",   title: "تحقيق أرباح 100,000 كونز",   description: "حقق إجمالي أرباح 100 ألف كونز.",             goalCount: 100000,rewardAmount: 20000,  rewardCurrency: "FREE", type: "ONETIME", actionType: "WIN_PROFIT_TOTAL", linkUrl: null },
      { key: "win_1M_coins_total",     title: "تحقيق أرباح 1,000,000 كونز", description: "حقق إجمالي أرباح مليون كونز.",               goalCount: 1000000,rewardAmount: 100000,rewardCurrency: "FREE", type: "ONETIME", actionType: "WIN_PROFIT_TOTAL", linkUrl: null },

      // 📱 Social Media Tasks (SOCIAL) - 10 tasks
      { key: "social_facebook",        title: "متابعة الصفحة الرسمية على فيسبوك",description: "الضغط على زر المتابعة من داخل التطبيق.",        goalCount: 1,     rewardAmount: 2000,  rewardCurrency: "FREE", type: "SOCIAL", actionType: "SOCIAL_FACEBOOK", linkUrl: "https://facebook.com/greedbox" },
      { key: "social_instagram",       title: "متابعة حساب إنستغرام",       description: "متابعة الحساب الرسمي.",                       goalCount: 1,     rewardAmount: 2000,  rewardCurrency: "FREE", type: "SOCIAL", actionType: "SOCIAL_INSTAGRAM", linkUrl: "https://instagram.com/greedbox" },
      { key: "social_tiktok",          title: "متابعة حساب تيك توك",        description: "متابعة الحساب الرسمي.",                       goalCount: 1,     rewardAmount: 3000,  rewardCurrency: "FREE", type: "SOCIAL", actionType: "SOCIAL_TIKTOK", linkUrl: "https://tiktok.com/@greedbox" },
      { key: "social_whatsapp",        title: "متابعة قناة واتساب",         description: "الانضمام لقناة التطبيق.",                       goalCount: 1,     rewardAmount: 2000,  rewardCurrency: "FREE", type: "SOCIAL", actionType: "SOCIAL_WHATSAPP", linkUrl: "https://whatsapp.com/channel/greedbox" },
      { key: "social_telegram",        title: "الاشتراك بقناة التلغرام",    description: "الانضمام لقناة التلغرام الرسمية.",             goalCount: 1,     rewardAmount: 2000,  rewardCurrency: "FREE", type: "SOCIAL", actionType: "SOCIAL_TELEGRAM", linkUrl: "https://t.me/greedbox" },
      { key: "watch_intro_video",      title: "مشاهدة فيديو التعريف بالتطبيق",description: "مشاهدة فيديو التعريف بالتطبيق.",              goalCount: 1,     rewardAmount: 1000,  rewardCurrency: "FREE", type: "SOCIAL", actionType: "WATCH_INTRO_VIDEO", linkUrl: "https://youtube.com/watch?v=greedbox" },
      { key: "share_app_5",            title: "مشاركة رابط التطبيق مع 5 أشخاص",description: "مشاركة رابط التطبيق مع 5 أشخاص.",             goalCount: 5,     rewardAmount: 3000,  rewardCurrency: "FREE", type: "SOCIAL", actionType: "APP_SHARE", linkUrl: null },
      { key: "share_app_20",           title: "مشاركة رابط التطبيق مع 20 شخص",description: "مشاركة رابط التطبيق مع 20 شخص.",           goalCount: 20,    rewardAmount: 10000, rewardCurrency: "FREE", type: "SOCIAL", actionType: "APP_SHARE", linkUrl: null },
      { key: "app_review",             title: "تقييم التطبيق 5 نجوم",       description: "تقييم التطبيق 5 نجوم.",                       goalCount: 1,     rewardAmount: 5000,  rewardCurrency: "FREE", type: "SOCIAL", actionType: "APP_REVIEW", linkUrl: "https://play.google.com/store" },
      { key: "social_join_all",        title: "الانضمام لجميع صفحات التطبيق الرسمية",description: "(فيسبوك + إنستغرام + تيك توك + واتساب + تلغرام)",goalCount: 5,     rewardAmount: 15000, rewardCurrency: "FREE", type: "SOCIAL", actionType: "SOCIAL_JOIN_ALL", linkUrl: null }
    ];

    for (const t of tasks) {
      await runQuery(
        `INSERT INTO "DailyTask" (id,key,title,description,"goalCount","rewardAmount","rewardCurrency","isEnabled",type,"actionType","linkUrl")
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10)
         ON CONFLICT (key) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           "goalCount" = EXCLUDED."goalCount",
           "rewardAmount" = EXCLUDED."rewardAmount",
           "rewardCurrency" = EXCLUDED."rewardCurrency",
           type = EXCLUDED.type,
           "actionType" = EXCLUDED."actionType",
           "linkUrl" = COALESCE("DailyTask"."linkUrl", EXCLUDED."linkUrl")`,
        [uuidv4(), t.key, t.title, t.description, t.goalCount, t.rewardAmount, t.rewardCurrency, t.type, t.actionType, t.linkUrl]
      );
    }
    console.log("✅ All tasks seeded.");

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

