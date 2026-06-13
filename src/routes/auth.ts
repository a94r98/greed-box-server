import { Router, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../db";
import { AuthenticatedRequest, authenticateToken } from "../authMiddleware";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "greed_boxes_super_secret_key";

function generateReferralCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Generates an 8-digit unique public ID
async function generateUniquePublicId(): Promise<string> {
  const min = 10000000;
  const max = 99999999;
  let attempts = 0;
  
  while (attempts < 100) {
    const candidate = Math.floor(min + Math.random() * (max - min)).toString();
    const existing = await prisma.user.findUnique({
      where: { publicId: candidate }
    });
    if (!existing) return candidate;
    attempts++;
  }
  return Math.floor(10000000 + Math.random() * 90000000).toString(); // Fallback
}

// 1. Guest Authentication / Registration (Multi-account checking, Device ID Banning, 8-digit ID)
router.post("/guest", async (req, res): Promise<any> => {
  const { deviceId, fingerprint, avatar } = req.body;
  if (!deviceId) {
    return res.status(400).json({ error: "Device ID is required." });
  }

  try {
    // Check if the device fingerprint or deviceId is permanently banned
    const banLogs = await prisma.eventLog.findMany({
      where: { eventType: "DEVICE_PERMANENT_BAN" }
    });
    const bannedDevice = banLogs.find((log: any) => log.message && log.message.includes(deviceId));

    if (bannedDevice) {
      return res.status(403).json({ error: "This device has been permanently banned from accessing Greedy Box." });
    }

    // Check if user with deviceId already exists and is a guest (no email)
    let user = await prisma.user.findFirst({
      where: { deviceId, email: null }
    });

    if (!user) {
      // Rule: Max 3 accounts per device limit (Bypassed for testing)
      /*
      const existingAccountsCount = await prisma.user.count({
        where: { deviceId }
      });

      if (existingAccountsCount >= 3) {
        return res.status(400).json({ error: "لقد تجاوزت الحد الأقصى للحسابات المسموح بإنشائها على هذا الجهاز (3 حسابات)." });
      }
      */

      // Create new Guest user
      const referralCode = generateReferralCode();
      const publicId = await generateUniquePublicId();
      user = await prisma.user.create({
        data: {
          publicId,
          deviceId,
          role: "GUEST",
          referralCode,
          username: `guest_${publicId}`,
          avatar: avatar || 'avatar_1',
        }
      });

      // Initialize Wallet
      await prisma.wallet.create({
        data: {
          userId: user.id,
          freeBalance: 1000.0, // Default Free Coins
          cashBalance: 0.0     // Default Cash
        }
      });

      await prisma.eventLog.create({
        data: {
          eventType: "USER_REGISTER_GUEST",
          userId: user.id,
          message: `Registered guest account ${publicId} on device ${deviceId}`
        }
      });
    }

    // Check if User is banned
    if (user.isBanned) {
      if (user.banExpiresAt && new Date() > new Date(user.banExpiresAt)) {
        // Unban since time passed
        await prisma.user.update({
          where: { id: user.id },
          data: { isBanned: false, banExpiresAt: null, banReason: null }
        });
      } else {
        const remaining = user.banExpiresAt 
          ? `حتى ${new Date(user.banExpiresAt).toLocaleString()}`
          : "حظر نهائي";
        return res.status(403).json({ error: `هذا الحساب محظور حالياً. (${remaining}). السبب: ${user.banReason || "غير محدد"}` });
      }
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, deviceId: user.deviceId },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        publicId: user.publicId,
        username: user.username,
        displayNickname: user.displayNickname,
        role: user.role,
        avatar: user.avatar,
        referralCode: user.referralCode,
        isGuest: true
      }
    });
  } catch (error) {
    console.error("Guest login error:", error);
    return res.status(500).json({ error: "Database operation failed." });
  }
});

// 2. Email Registration (Age limit, device account limit, 8-digit unique ID)
router.post("/register", async (req, res): Promise<any> => {
  const { email, password, username, displayNickname, age, gender, avatar, deviceId, refCode } = req.body;
  if (!email || !password || !deviceId || !username) {
    return res.status(400).json({ error: "جميع الحقول المطلوبة يجب ملؤها." });
  }

  // Age validation
  if (age !== undefined && parseInt(age) < 18) {
    return res.status(400).json({ error: "عذراً، يجب أن يكون عمرك 18 سنة أو أكثر للتسجيل." });
  }

  try {
    // Check if the device is banned
    const banLogs = await prisma.eventLog.findMany({
      where: { eventType: "DEVICE_PERMANENT_BAN" }
    });
    const bannedDevice = banLogs.find((log: any) => log.message && log.message.includes(deviceId));
    if (bannedDevice) {
      return res.status(403).json({ error: "هذا الجهاز محظور نهائياً من اللعب." });
    }

    // Check if email already taken
    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      return res.status(400).json({ error: "البريد الإلكتروني مسجل بالفعل." });
    }

    // Check if username already taken
    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) {
      return res.status(400).json({ error: "اسم المستخدم (Username) مستخدم بالفعل." });
    }

    // Rule: Max 3 accounts per device limit (Bypassed for testing)
    /*
    const existingAccountsCount = await prisma.user.count({
      where: { deviceId }
    });
    if (existingAccountsCount >= 3) {
      return res.status(400).json({ error: "لقد تجاوزت الحد الأقصى للحسابات المسموح بإنشائها على هذا الجهاز (3 حسابات)." });
    }
    */

    const passwordHash = await bcrypt.hash(password, 10);
    const referralCode = generateReferralCode();
    const publicId = await generateUniquePublicId();

    const user = await prisma.$transaction(async (tx) => {
      const config = await tx.systemConfig.findUnique({ where: { id: "singleton" } });

      let inviterId: string | null = null;
      if (refCode && config?.isReferralActive) {
        const inviter = await tx.user.findUnique({ where: { referralCode: refCode } });
        if (inviter) {
          inviterId = inviter.id;
        }
      }

      const newUser = await tx.user.create({
        data: {
          publicId,
          email,
          passwordHash,
          username,
          displayNickname: displayNickname || username,
          age: age ? parseInt(age) : null,
          gender,
          avatar: avatar || 'avatar_1',
          deviceId,
          role: "USER",
          referralCode,
          referredByCode: refCode || null
        }
      });

      // Wallet Initializer
      await tx.wallet.create({
        data: {
          userId: newUser.id,
          freeBalance: 1000.0, // Default Coins
          cashBalance: 0.0
        }
      });

      if (inviterId) {
        await tx.referral.create({
          data: {
            inviterId,
            inviteeId: newUser.id,
            bonusPaid: false
          }
        });
      }

      return newUser;
    });

    // ─── TASK SYSTEM TRIGGERS ──────────────────────────────────────────────
    try {
      const { trackTaskProgress } = require("../taskTracker");
      await trackTaskProgress(user.id, "CREATE_ACCOUNT", 1);
      if (email) {
        await trackTaskProgress(user.id, "PROFILE_EMAIL", 1);
      }
      if (refCode) {
        const inviter = await prisma.user.findUnique({ where: { referralCode: refCode } });
        if (inviter) {
          await trackTaskProgress(inviter.id, "INVITE_FRIEND", 1);
          await trackTaskProgress(inviter.id, "INVITE_FRIENDS_TOTAL", 1);
        }
      }
    } catch (taskErr) {
      console.error("Error updating tasks on registration:", taskErr);
    }

    await prisma.eventLog.create({
      data: {
        eventType: "USER_REGISTER",
        userId: user.id,
        message: `Registered user ${user.publicId} with email ${email} on device ${deviceId}`
      }
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, deviceId: user.deviceId },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        publicId: user.publicId,
        email: user.email,
        username: user.username,
        displayNickname: user.displayNickname,
        role: user.role,
        avatar: user.avatar,
        referralCode: user.referralCode,
        isGuest: false
      }
    });
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ error: "فشل في إنشاء الحساب." });
  }
});

// 3. Login Endpoint (Supports Email login AND 8-digit unique ID login + Ban check)
router.post("/login", async (req, res): Promise<any> => {
  const { loginInput, email, password } = req.body;
  // Fallback to compatibility 'email' field if loginInput not present
  const identifier = loginInput || email;
  if (!identifier || !password) {
    return res.status(400).json({ error: "يرجى إدخال البريد الإلكتروني أو الـ ID مع كلمة المرور." });
  }

  try {
    // Find user by email OR publicId (8-digit ID)
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { publicId: identifier }
        ]
      }
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    }

    // Check if user is banned
    if (user.isBanned) {
      if (user.banExpiresAt && new Date() > new Date(user.banExpiresAt)) {
        // Unban since time passed
        await prisma.user.update({
          where: { id: user.id },
          data: { isBanned: false, banExpiresAt: null, banReason: null }
        });
      } else {
        const remaining = user.banExpiresAt 
          ? `حتى ${new Date(user.banExpiresAt).toLocaleString()}`
          : "حظر نهائي";
        return res.status(403).json({ error: `هذا الحساب محظور حالياً. (${remaining}). السبب: ${user.banReason || "غير محدد"}` });
      }
    }

    // Track Login in Event Logs
    await prisma.eventLog.create({
      data: {
        eventType: "USER_LOGIN",
        userId: user.id,
        message: `Logged in user ${user.publicId} via identifier ${identifier}`
      }
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, deviceId: user.deviceId },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        publicId: user.publicId,
        email: user.email,
        username: user.username,
        displayNickname: user.displayNickname,
        role: user.role,
        avatar: user.avatar,
        referralCode: user.referralCode,
        isGuest: user.role === "GUEST"
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء عملية تسجيل الدخول." });
  }
});

// 4. Upgrade / Link Guest Account (Promotes GUEST to USER, sets email and password)
router.post("/link", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const { email, password, username, displayNickname, age, gender } = req.body;
  const userId = req.user?.id;

  if (!email || !password || !userId) {
    return res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور مطلوبة لترقية الحساب." });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود." });
    }
    if (user.email) {
      return res.status(400).json({ error: "الحساب مربوط بالفعل ببريد إلكتروني." });
    }

    // Check if email already in use
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: "البريد الإلكتروني مسجل بالفعل بحساب آخر." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        email,
        passwordHash,
        username: username || user.username,
        displayNickname: displayNickname || user.displayNickname,
        age: age ? parseInt(age) : null,
        gender: gender || null,
        role: "USER" // Promote to USER
      }
    });

    await prisma.eventLog.create({
      data: {
        eventType: "USER_LINK_ACCOUNT",
        userId: updatedUser.id,
        message: `Linked guest account ${updatedUser.publicId} to email ${email}`
      }
    });

    // ─── TASK SYSTEM TRIGGERS ──────────────────────────────────────────────
    try {
      const { trackTaskProgress } = require("../taskTracker");
      await trackTaskProgress(updatedUser.id, "CREATE_ACCOUNT", 1);
      await trackTaskProgress(updatedUser.id, "PROFILE_EMAIL", 1);
    } catch (taskErr) {
      console.error("Error updating tasks on guest upgrade:", taskErr);
    }

    const token = jwt.sign(
      { id: updatedUser.id, email: updatedUser.email, role: updatedUser.role, deviceId: updatedUser.deviceId },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      message: "تم ترقية حساب الضيف بنجاح.",
      token,
      user: {
        id: updatedUser.id,
        publicId: updatedUser.publicId,
        email: updatedUser.email,
        username: updatedUser.username,
        displayNickname: updatedUser.displayNickname,
        role: updatedUser.role,
        avatar: updatedUser.avatar,
        referralCode: updatedUser.referralCode,
        isGuest: false
      }
    });
  } catch (error) {
    console.error("Link account error:", error);
    return res.status(500).json({ error: "فشل ربط حساب الضيف." });
  }
});

// 5. Password Recovery
router.post("/recover-password", async (req, res): Promise<any> => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "البريد الإلكتروني مطلوب." });
  }
  
  // Return mock code verify token success
  return res.json({
    message: "تم إرسال رمز تحقق استعادة الحساب إلى بريدك الإلكتروني.",
    verificationCode: "777777" // Standard mock verification code
  });
});

// 6. Reset password via recovery code
router.post("/reset-password", async (req, res): Promise<any> => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: "الحقول مطلوبة." });
  }

  if (code !== "777777") {
    return res.status(400).json({ error: "رمز التحقق غير صحيح." });
  }

  try {
    const user = await prisma.user.findFirst({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: "الحساب غير موجود." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash }
    });

    await prisma.eventLog.create({
      data: {
        eventType: "USER_RESET_PASSWORD",
        userId: user.id,
        message: `Reset password for user ${user.publicId} via verification code`
      }
    });

    return res.json({ message: "تم تغيير كلمة المرور بنجاح. يمكنك الدخول الآن." });
  } catch (error) {
    return res.status(500).json({ error: "فشل إعادة تعيين كلمة المرور." });
  }
});

export default router;
