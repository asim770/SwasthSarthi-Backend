import mongoose from "mongoose";
import { env } from "@/lib/env";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  var mongooseCache: MongooseCache | undefined;
}

let cached: MongooseCache = global.mongooseCache || { conn: null, promise: null };

if (!global.mongooseCache) {
  global.mongooseCache = cached;
}

export type DbConnectionStatus = "connected" | "connecting" | "disconnecting" | "disconnected";

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts: mongoose.ConnectOptions = {
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
    };

    cached.promise = mongoose
      .connect(env.MONGODB_URI, opts)
      .then((m) => {
        console.log("✅ MongoDB connected successfully to SwasthSaarthi database");
        return m;
      })
      .catch((err) => {
        console.error("❌ MongoDB connection error:", err.message);
        cached.promise = null;
        throw err;
      });
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    throw err;
  }

  return cached.conn;
}

export function getDatabaseStatus(): {
  status: DbConnectionStatus;
  readyState: number;
  databaseName?: string;
} {
  const readyStates: Record<number, DbConnectionStatus> = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  const state = mongoose.connection.readyState;
  return {
    status: readyStates[state] ?? "disconnected",
    readyState: state,
    databaseName: mongoose.connection.name || undefined,
  };
}
