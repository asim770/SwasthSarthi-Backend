import { connectToDatabase } from "./lib/db/connect";
import { getRedisStatus } from "./lib/queue/redis";
import { initConsentWorker } from "./lib/queue/consentWorker";
import { initTransferWorker } from "./lib/queue/transferWorker";
import { initNotificationWorker } from "./lib/queue/notificationWorker";

async function main() {
  console.log("🚀 Initializing SwasthSaarthi BullMQ Background Workers...");
  await connectToDatabase();
  console.log("✅ MongoDB connected for background workers");

  let workersStarted = false;

  const tryStartWorkers = async () => {
    const redis = await getRedisStatus();
    if (redis.status === "connected") {
      if (!workersStarted) {
        console.log(`✅ Redis connected (latency: ${redis.latencyMs}ms)`);
        const consentWorker = initConsentWorker();
        const transferWorker = initTransferWorker();
        const notificationWorker = initNotificationWorker();
        console.log("✅ BullMQ background workers activated and listening for jobs:");
        console.log(`   - Consent Maintenance Worker: ${consentWorker ? "Active" : "Failed"}`);
        console.log(`   - ABDM Data Transfer Worker: ${transferWorker ? "Active" : "Failed"}`);
        console.log(`   - Notification Dispatch Worker: ${notificationWorker ? "Active" : "Failed"}`);
        workersStarted = true;
      }
    } else {
      if (!workersStarted) {
        console.warn(`⚠️ Redis is currently ${redis.status}. BullMQ workers are standing by.`);
        console.warn("👉 Start Redis with: docker compose up -d redis  OR  brew services start redis");
        console.warn("ℹ️ Note: SwasthSaarthi automatically uses resilient direct in-process processing when Redis is offline.");
      }
    }
  };

  await tryStartWorkers();

  // Periodically check if Redis comes online if not yet started
  setInterval(async () => {
    if (!workersStarted) {
      await tryStartWorkers();
    }
  }, 10000);
}

main().catch((err) => {
  console.error("Worker initialization error:", err);
  process.exit(1);
});
