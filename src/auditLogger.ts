import { prisma } from "./db";
import { EventType } from "./constants";

export interface LogParams {
  roundId?: string;
  requestId?: string;
  eventType: EventType;
  userId?: string;
  message: string;
  sequenceNumber?: number;
}

export async function logEvent(params: LogParams) {
  try {
    const log = await prisma.eventLog.create({
      data: {
        roundId: params.roundId || null,
        requestId: params.requestId || null,
        eventType: params.eventType,
        userId: params.userId || null,
        message: params.message,
        sequenceNumber: params.sequenceNumber || 0
      }
    });
    console.log(`[AuditLog - ${params.eventType}]: ${params.message}`);
    return log;
  } catch (error) {
    console.error("Failed to write event log to database:", error);
  }
}
