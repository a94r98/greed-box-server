import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "greed_boxes_super_secret_key";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    role: string;
    deviceId: string;
  };
}

export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token is required." });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token." });
    }
    req.user = decoded as AuthenticatedRequest["user"];
    next();
  });
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || (req.user.role !== "ADMIN" && req.user.role !== "SUPERADMIN")) {
    return res.status(403).json({ error: "Administrative privilege required." });
  }
  next();
}

export function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Super Administrator privilege required." });
  }
  next();
}

export function restrictGuest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // If the user's account has no email or is marked as guest (role or username based)
  if (req.user && (!req.user.email || req.user.role === "GUEST")) {
    return res.status(403).json({
      error: "Action restricted. Please sign up or link an account to perform this operation.",
      requiresUpgrade: true
    });
  }
  next();
}
