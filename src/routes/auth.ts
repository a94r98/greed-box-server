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

// 1. Guest Authentication / Registration
router.post("/guest", async (req, res): Promise<any> => {
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ error: "Device ID is required." });
  }

  try {
    // Check if user with deviceId already exists and is a guest (no email)
    let user = await prisma.user.findFirst({
      where: { deviceId, email: null }
    });

    if (!user) {
      // Create new Guest user
      const referralCode = generateReferralCode();
      user = await prisma.user.create({
        data: {
          deviceId,
          role: "GUEST",
          referralCode,
          username: `Guest_${referralCode}`
        }
      });

      // Initialize Wallet
      await prisma.wallet.create({
        data: {
          userId: user.id,
          freeBalance: 1000000.0,
          cashBalance: 100000.0
        }
      });
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
        username: user.username,
        role: user.role,
        avatar: user.avatar,
        referralCode: user.referralCode
      }
    });
  } catch (error) {
    console.error("Guest login error:", error);
    return res.status(500).json({ error: "Database operation failed." });
  }
});

// 2. Email Registration
router.post("/register", async (req, res): Promise<any> => {
  const { email, password, username, deviceId, refCode } = req.body;
  if (!email || !password || !deviceId) {
    return res.status(400).json({ error: "Email, password, and Device ID are required." });
  }

  try {
    // Check if email already taken
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: "Email is already registered." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const referralCode = generateReferralCode();

    // Perform inside transaction to link wallet and referrals cleanly
    const user = await prisma.$transaction(async (tx) => {
      // Check system configuration to verify referral payouts
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
          email,
          passwordHash,
          username: username || email.split("@")[0],
          deviceId,
          role: "USER",
          referralCode,
          referredByCode: refCode || null
        }
      });

      // Wallet
      await tx.wallet.create({
        data: {
          userId: newUser.id,
          freeBalance: 1000000.0,
          cashBalance: 100000.0
        }
      });

      // If referred, log the referral relation
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

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, deviceId: user.deviceId },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        avatar: user.avatar,
        referralCode: user.referralCode
      }
    });
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ error: "Failed to create account." });
  }
});

// 3. Email Login
router.post("/login", async (req, res): Promise<any> => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, deviceId: user.deviceId },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        avatar: user.avatar,
        referralCode: user.referralCode
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "An error occurred during login." });
  }
});

// 4. Upgrade / Link Guest Account
router.post("/link", authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<any> => {
  const { email, password, username } = req.body;
  const userId = req.user?.id;

  if (!email || !password || !userId) {
    return res.status(400).json({ error: "Email and password are required to link account." });
  }

  try {
    // Check if user is currently a Guest
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    if (user.email) {
      return res.status(400).json({ error: "Account is already linked to an email." });
    }

    // Check if email is already in use by another user
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: "Email is already registered on another account." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        email,
        passwordHash,
        username: username || user.username,
        role: "USER" // Promote to USER
      }
    });

    const token = jwt.sign(
      { id: updatedUser.id, email: updatedUser.email, role: updatedUser.role, deviceId: updatedUser.deviceId },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      message: "Guest account successfully linked and promoted.",
      token,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        username: updatedUser.username,
        role: updatedUser.role,
        avatar: updatedUser.avatar,
        referralCode: updatedUser.referralCode
      }
    });
  } catch (error) {
    console.error("Link account error:", error);
    return res.status(500).json({ error: "Failed to link guest account." });
  }
});

// 5. Password Recovery Request
router.post("/recover-password", async (req, res): Promise<any> => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email is required." });
  }
  
  // Simulated success response
  return res.json({
    message: "If the email is registered, password recovery instructions have been sent."
  });
});

export default router;
