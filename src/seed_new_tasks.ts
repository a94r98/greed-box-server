import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const newTasks = [
  // ONETIME TASKS
  {
    key: "onetime_follow_facebook",
    title: "متابعة الصفحة الرسمية فيس بوك",
    description: "قم بمتابعة صفحتنا على فيسبوك للحصول على المكافأة",
    goalCount: 1,
    rewardAmount: 200000,
    rewardCurrency: "CASH",
    type: "ONETIME",
    actionType: "FOLLOW_FACEBOOK",
  },
  {
    key: "onetime_follow_instagram",
    title: "متابعة الصفحة الرسمية انستغرام",
    description: "قم بمتابعة حسابنا على انستغرام للحصول على المكافأة",
    goalCount: 1,
    rewardAmount: 250000,
    rewardCurrency: "CASH",
    type: "ONETIME",
    actionType: "FOLLOW_INSTAGRAM",
  },
  {
    key: "onetime_follow_tiktok",
    title: "متابعة الصفحة الرسمية تيكتوك",
    description: "قم بمتابعة حسابنا على تيكتوك للحصول على المكافأة",
    goalCount: 1,
    rewardAmount: 350000,
    rewardCurrency: "CASH",
    type: "ONETIME",
    actionType: "FOLLOW_TIKTOK",
  },
  {
    key: "onetime_follow_whatsapp",
    title: "متابعة الصفحة الرسمية واتساب",
    description: "قم بالاشتراك في قناة واتساب الرسمية",
    goalCount: 1,
    rewardAmount: 300000,
    rewardCurrency: "CASH",
    type: "ONETIME",
    actionType: "FOLLOW_WHATSAPP",
  },
  {
    key: "onetime_follow_telegram",
    title: "متابعة الصفحة الرسمية تلجرام",
    description: "قم بالاشتراك في قناة تلجرام الرسمية",
    goalCount: 1,
    rewardAmount: 200000,
    rewardCurrency: "CASH",
    type: "ONETIME",
    actionType: "FOLLOW_TELEGRAM",
  },
  {
    key: "onetime_rate_app",
    title: "تقيم التطبيق 5 نجوم",
    description: "قيم التطبيق 5 نجوم على المتجر لتدعمنا",
    goalCount: 1,
    rewardAmount: 1000000,
    rewardCurrency: "CASH",
    type: "ONETIME",
    actionType: "RATE_APP",
  },
  {
    key: "onetime_add_phone",
    title: "اضف رقم هاتفك",
    description: "أضف رقم هاتفك لحماية حسابك",
    goalCount: 1,
    rewardAmount: 1000000,
    rewardCurrency: "CASH",
    type: "ONETIME",
    actionType: "ADD_PHONE",
  },

  // DAILY TASKS
  {
    key: "daily_login",
    title: "تسجيل دخول يومي",
    description: "سجل الدخول يومياً للحصول على الجائزة",
    goalCount: 1,
    rewardAmount: 100000, // placeholder
    rewardCurrency: "CASH",
    type: "DAILY",
    actionType: "DAILY_LOGIN",
  },
  {
    key: "daily_invite_5",
    title: "دعوة 5 اصدقاء",
    description: "قم بدعوة 5 أصدقاء لربح المكافأة",
    goalCount: 5,
    rewardAmount: 100000, // placeholder
    rewardCurrency: "CASH",
    type: "DAILY",
    actionType: "INVITE_FRIENDS",
  },
  {
    key: "daily_share_app_5",
    title: "مشاركة رابط التطبيق 5 مرات",
    description: "شارك التطبيق مع أصدقائك",
    goalCount: 5,
    rewardAmount: 100000, // placeholder
    rewardCurrency: "CASH",
    type: "DAILY",
    actionType: "SHARE_APP",
  },
  {
    key: "daily_online_60",
    title: "ابق متصل 60 دقيقة",
    description: "العب في التطبيق لمدة 60 دقيقة",
    goalCount: 60,
    rewardAmount: 100000, // placeholder
    rewardCurrency: "CASH",
    type: "DAILY",
    actionType: "ONLINE_MINUTES",
  },
  {
    key: "daily_charge_10m",
    title: "اشحن كونزات 10 M",
    description: "اشحن ما يعادل 10 مليون كونز",
    goalCount: 10000000,
    rewardAmount: 100000, // placeholder
    rewardCurrency: "CASH",
    type: "DAILY",
    actionType: "CHARGE_COINS",
  },
  {
    key: "daily_charge_30m",
    title: "اشحن كونزات 30 M",
    description: "اشحن ما يعادل 30 مليون كونز",
    goalCount: 30000000,
    rewardAmount: 100000, // placeholder
    rewardCurrency: "CASH",
    type: "DAILY",
    actionType: "CHARGE_COINS",
  },
  {
    key: "daily_charge_60m",
    title: "اشحن كونزات 60 M",
    description: "اشحن ما يعادل 60 مليون كونز",
    goalCount: 60000000,
    rewardAmount: 100000, // placeholder
    rewardCurrency: "CASH",
    type: "DAILY",
    actionType: "CHARGE_COINS",
  },
  {
    key: "daily_charge_80m",
    title: "اشحن كونزات 80 M",
    description: "اشحن ما يعادل 80 مليون كونز",
    goalCount: 80000000,
    rewardAmount: 100000, // placeholder
    rewardCurrency: "CASH",
    type: "DAILY",
    actionType: "CHARGE_COINS",
  },
];

async function main() {
  console.log("Deleting old tasks...");
  await prisma.taskProgress.deleteMany({});
  await prisma.dailyTask.deleteMany({});

  console.log("Seeding new tasks...");
  for (const task of newTasks) {
    await prisma.dailyTask.create({
      data: task,
    });
  }

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
