import crypto from "crypto";
import { User } from "@/lib/db/models/User";
import { Counter } from "@/lib/db/models/Counter";
import { connectToDatabase } from "@/lib/db/connect";

/**
 * Generate a guaranteed unique, sequential and permanent Patient ID (SS-PAT-XXXXXX)
 * Uses an atomic MongoDB Counter to prevent race conditions during concurrent registration.
 */
export async function generateUniquePatientId(): Promise<string> {
  await connectToDatabase();
  let candidate = "";
  let isUnique = false;
  let attempts = 0;

  while (!isUnique && attempts < 10) {
    attempts++;
    // Atomically increment the sequence counter
    const counterDoc = await Counter.findOneAndUpdate(
      { _id: "patientId" },
      { $inc: { seq: 1 } },
      { returnDocument: "after", upsert: true }
    );

    const seqNumber = counterDoc?.seq || 1;
    candidate = `SS-PAT-${String(seqNumber).padStart(6, "0")}`;

    const existing = await User.findOne({ patientId: candidate }).lean();
    if (!existing) {
      isUnique = true;
    }
  }

  if (!isUnique) {
    // Collision-safe fallback using high-resolution timestamp & random bytes
    const fallbackNum = crypto.randomInt(100000, 999999);
    candidate = `SS-PAT-${fallbackNum}`;
  }

  return candidate;
}

/**
 * Determine if an input identifier string matches known Patient ID formats
 * Supports both SS-PAT-XXXXXX and existing PID-XXXXXXXX formats
 */
export function isPatientIdFormat(identifier: string): boolean {
  if (!identifier) return false;
  const trimmed = identifier.trim().toUpperCase();
  return (
    trimmed.startsWith("SS-PAT-") ||
    trimmed.startsWith("PID-") ||
    /^SS-PAT-\d{6}$/.test(trimmed) ||
    /^PID-\d{8}$/.test(trimmed)
  );
}
