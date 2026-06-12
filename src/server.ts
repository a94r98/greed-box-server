import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

import { initializeDatabase } from "./db";
import gameEngine from "./gameEngine";
import authRoutes from "./routes/auth";
import playerRoutes from "./routes/player";
import adminRoutes from "./routes/admin";
import { logEvent } from "./auditLogger";
import { EventType } from "./constants";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "greed_boxes_super_secret_key";

app.use(cors());
app.use(express.json());

// Attach API Routes
app.use("/api/auth", authRoutes);
app.use("/api/player", playerRoutes);
app.use("/api/admin", adminRoutes);

// Socket.io Connection Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error("Authentication token is required."));
  }

  jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
    if (err) {
      return next(new Error("Invalid session token."));
    }
    (socket as any).user = decoded;
    next();
  });
});

// Real-Time Socket Connections handler
io.on("connection", (socket) => {
  const user = (socket as any).user;
  console.log(`[WebSocket] Client connected: User ${user.id} (${user.role})`);

  // Join User specific channel for private winnings notifications
  socket.join(`user:${user.id}`);

  // Send current state immediately on connect
  socket.emit("round_state_change", gameEngine.getCurrentRound());

  // Listen for bet placements over socket
  socket.on("place_bet", async (data, callback) => {
    const { boxIndex, amount, clientBetId } = data;
    if (boxIndex === undefined || amount === undefined || !clientBetId) {
      return callback({ error: "Missing bet parameters." });
    }

    try {
      const activeBet = await gameEngine.placeBet(user.id, boxIndex, amount, clientBetId);
      callback({ success: true, bet: activeBet });
    } catch (err: any) {
      callback({ error: err.message || "Failed to place bet." });
    }
  });

  socket.on("disconnect", () => {
    console.log(`[WebSocket] Client disconnected: User ${user.id}`);
  });
});

// HTTP REST Fallback / Recovery State endpoint
app.get("/api/rounds/current", async (req, res): Promise<any> => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  
  if (!token) {
    return res.status(401).json({ error: "Authorization required." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const currentRound = gameEngine.getCurrentRound();
    const userBets = gameEngine.getUserBets(decoded.id);

    return res.json({
      round: currentRound,
      myBets: userBets
    });
  } catch (err) {
    return res.status(403).json({ error: "Invalid credentials." });
  }
});

// Setup fallback recovery endpoint details
app.get("/", (req, res) => {
  res.send("Greed Boxes Real-Time Server running.");
});

// Start HTTP server immediately regardless of DB status
server.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});

// Initialize DB and Launch Game Engine in background
async function main() {
  try {
    await initializeDatabase();
    gameEngine.setIo(io);
    await gameEngine.start();
    console.log("✅ Game engine started successfully.");
  } catch (err) {
    console.error("❌ Critical server launch error:", err);
    console.error("Server is running but game engine failed to start. Check DB connection.");
  }
}

main();
