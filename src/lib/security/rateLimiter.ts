interface RateLimitEntry {
  timestamps: number[];
}

const storage = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of storage.entries()) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < 600000); // 10 minutes max window
    if (entry.timestamps.length === 0) {
      storage.delete(key);
    }
  }
}, 60000).unref(); // unref so it does not block Node process exit in tests

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}

/**
 * Sliding window rate limiter
 * @param key Unique key (e.g. IP or identifier or challenge ID)
 * @param maxRequests Maximum requests allowed within window
 * @param windowMs Window duration in milliseconds
 */
export function checkRateLimit(
  key: string,
  maxRequests: number = 5,
  windowMs: number = 300000 // 5 minutes default
): RateLimitResult {
  const now = Date.now();
  let entry = storage.get(key);

  if (!entry) {
    entry = { timestamps: [] };
    storage.set(key, entry);
  }

  // Filter out timestamps outside window
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  if (entry.timestamps.length >= maxRequests) {
    const oldestTimestamp = entry.timestamps[0];
    const resetInSeconds = Math.ceil((oldestTimestamp + windowMs - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetInSeconds: Math.max(resetInSeconds, 1),
    };
  }

  // Record this attempt
  entry.timestamps.push(now);
  return {
    allowed: true,
    remaining: maxRequests - entry.timestamps.length,
    resetInSeconds: Math.ceil(windowMs / 1000),
  };
}

/**
 * Reset rate limit counter for a key (used in tests)
 */
export function resetRateLimit(key: string): void {
  storage.delete(key);
}

/**
 * Clear all rate limits (used in test teardown)
 */
export function clearAllRateLimits(): void {
  storage.clear();
}
