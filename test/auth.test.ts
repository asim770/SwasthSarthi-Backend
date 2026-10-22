import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { seedDemoIdentities, DEMO_IDENTITIES } from "@/lib/db/seed";
import { User } from "@/lib/db/models/User";
import { AuthChallenge } from "@/lib/db/models/AuthChallenge";
import { Session } from "@/lib/db/models/Session";
import {
  createSession,
  validateSession,
  invalidateSession,
  requireAuth,
} from "@/lib/auth/session";
import {
  generateRandomOtp,
  hashOtp,
  generateSecureToken,
  hashToken,
} from "@/lib/security/crypto";
import {
  checkRateLimit,
  clearAllRateLimits,
} from "@/lib/security/rateLimiter";
import {
  buildSessionCookie,
  buildCsrfCookie,
  getCookieFromRequest,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from "@/lib/security/cookies";
import { validateCsrf } from "@/lib/security/csrf";

// Direct Route Handlers for HTTP endpoint testing
import { POST as challengeHandler } from "@/app/api/v1/auth/challenge/route";
import { POST as verifyHandler } from "@/app/api/v1/auth/verify/route";
import { GET as meHandler } from "@/app/api/v1/auth/me/route";
import { POST as logoutHandler } from "@/app/api/v1/auth/logout/route";
import { GET as mockOtpHandler } from "@/app/api/v1/auth/mock-otp/route";
import { NextRequest } from "next/server";

describe("SwasthSaarthi — Step 4: Authentication & Session Security Suite", () => {
  before(async () => {
    await connectToDatabase();
    await seedDemoIdentities();
  });

  after(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    clearAllRateLimits();
    await AuthChallenge.deleteMany({});
  });

  test("1. Valid mock OTP login generates active session and secure cookies", async () => {
    // 1. Create challenge
    const challengeReq = new NextRequest("http://localhost:3001/api/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "rahul.verma@sbx" }),
    });

    const challengeRes = await challengeHandler(challengeReq);
    assert.equal(challengeRes.status, 201);
    const challengeBody = await challengeRes.json();
    assert.equal(challengeBody.success, true);
    assert.ok(challengeBody.data.challengeId);
    assert.ok(challengeBody.data.maskedIdentifier.includes("@sbx"));

    // 2. Fetch mock OTP via dev channel
    const devOtpReq = new NextRequest(
      `http://localhost:3001/api/v1/auth/mock-otp?challengeId=${challengeBody.data.challengeId}`
    );
    const devOtpRes = await mockOtpHandler(devOtpReq);
    assert.equal(devOtpRes.status, 200);
    const devOtpBody = await devOtpRes.json();
    const otp = devOtpBody.data.demoOtp;
    assert.match(otp, /^\d{6}$/);

    // 3. Verify OTP
    const verifyReq = new NextRequest("http://localhost:3001/api/v1/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challengeBody.data.challengeId,
        otp,
      }),
    });

    const verifyRes = await verifyHandler(verifyReq);
    assert.equal(verifyRes.status, 200);
    const verifyBody = await verifyRes.json();

    assert.equal(verifyBody.success, true);
    assert.equal(verifyBody.data.user.role, "patient");
    assert.equal(verifyBody.data.user.name, "Rahul Verma");
    assert.ok(verifyBody.data.csrfToken);

    // Verify cookies set
    const setCookieHeaders = verifyRes.headers.getSetCookie();
    assert.ok(setCookieHeaders.some((c) => c.includes("ss_session=") && c.includes("HttpOnly")));
    assert.ok(setCookieHeaders.some((c) => c.includes("ss_csrf=")));
  });

  test("2. Invalid OTP is rejected with remaining attempts counter", async () => {
    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    assert.ok(user);

    const challengeId = "test-challenge-invalid-otp";
    const realOtp = "123456";
    await AuthChallenge.create({
      challengeId,
      identifier: "rahul.verma@sbx",
      userId: user._id,
      otpHash: hashOtp(realOtp, challengeId),
      attempts: 0,
      maxAttempts: 3,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 300000),
    });

    const verifyReq = new NextRequest("http://localhost:3001/api/v1/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, otp: "999999" }),
    });

    const verifyRes = await verifyHandler(verifyReq);
    assert.equal(verifyRes.status, 401);
    const body = await verifyRes.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_OTP");
    assert.ok(body.error.message.includes("2 attempt(s) remaining"));
  });

  test("3. Expired challenge is rejected with HTTP 410", async () => {
    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    const challengeId = "test-challenge-expired";
    const realOtp = "555555";

    // Expired 10 seconds ago
    await AuthChallenge.create({
      challengeId,
      identifier: "rahul.verma@sbx",
      userId: user!._id,
      otpHash: hashOtp(realOtp, challengeId),
      attempts: 0,
      maxAttempts: 3,
      status: "PENDING",
      expiresAt: new Date(Date.now() - 10000),
    });

    const verifyReq = new NextRequest("http://localhost:3001/api/v1/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, otp: realOtp }),
    });

    const verifyRes = await verifyHandler(verifyReq);
    assert.equal(verifyRes.status, 410);
    const body = await verifyRes.json();
    assert.equal(body.error.code, "CHALLENGE_EXPIRED");
  });

  test("4. Excessive verification attempts locks challenge and rejects further tries", async () => {
    const user = await User.findOne({ abhaAddress: "dr.ananya@hpr.sbx" });
    const challengeId = "test-challenge-attempts-lock";
    const realOtp = "777777";

    await AuthChallenge.create({
      challengeId,
      identifier: "dr.ananya@hpr.sbx",
      userId: user!._id,
      otpHash: hashOtp(realOtp, challengeId),
      attempts: 0,
      maxAttempts: 3,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 300000),
    });

    // Attempt 1 (wrong)
    await verifyHandler(
      new NextRequest("http://localhost:3001/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, otp: "000001" }),
      })
    );

    // Attempt 2 (wrong)
    await verifyHandler(
      new NextRequest("http://localhost:3001/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, otp: "000002" }),
      })
    );

    // Attempt 3 (wrong - exhausts attempts)
    const res3 = await verifyHandler(
      new NextRequest("http://localhost:3001/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, otp: "000003" }),
      })
    );
    assert.equal(res3.status, 403);
    const body3 = await res3.json();
    assert.equal(body3.error.code, "CHALLENGE_EXHAUSTED");

    // Attempt 4 even with correct OTP must now be rejected
    const res4 = await verifyHandler(
      new NextRequest("http://localhost:3001/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, otp: realOtp }),
      })
    );
    assert.equal(res4.status, 403);
  });

  test("5. Reusing a successfully consumed challenge is rejected", async () => {
    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    const challengeId = "test-challenge-replay-check";
    const realOtp = "345678";

    await AuthChallenge.create({
      challengeId,
      identifier: "rahul.verma@sbx",
      userId: user!._id,
      otpHash: hashOtp(realOtp, challengeId),
      attempts: 0,
      maxAttempts: 3,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 300000),
    });

    // First use: Valid
    const res1 = await verifyHandler(
      new NextRequest("http://localhost:3001/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, otp: realOtp }),
      })
    );
    assert.equal(res1.status, 200);

    // Replay attempt with same challenge
    const res2 = await verifyHandler(
      new NextRequest("http://localhost:3001/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, otp: realOtp }),
      })
    );
    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.error.code, "CHALLENGE_ALREADY_CONSUMED");
  });

  test("6. Concurrent verification requests only allow one consumer", async () => {
    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    const challengeId = "test-challenge-concurrency";
    const realOtp = "654321";

    await AuthChallenge.create({
      challengeId,
      identifier: "rahul.verma@sbx",
      userId: user!._id,
      otpHash: hashOtp(realOtp, challengeId),
      attempts: 0,
      maxAttempts: 3,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 300000),
    });

    const makeRequest = () =>
      verifyHandler(
        new NextRequest("http://localhost:3001/api/v1/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId, otp: realOtp }),
        })
      );

    // Fire 2 simultaneous verification requests
    const [resA, resB] = await Promise.all([makeRequest(), makeRequest()]);

    const statuses = [resA.status, resB.status];
    assert.ok(statuses.includes(200), "One request must succeed");
    assert.ok(
      statuses.includes(409) || statuses.includes(400) || statuses.includes(401),
      "The concurrent second request must be rejected"
    );

    // Confirm in DB status is CONSUMED exactly once
    const updated = await AuthChallenge.findOne({ challengeId });
    assert.equal(updated!.status, "CONSUMED");
  });

  test("7. Session expiry and inactivity sliding timeout", async () => {
    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);

    // Create session that expired 5 minutes ago
    await Session.create({
      sessionId: `test-expired-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tokenHash,
      userId: user!._id,
      role: "patient",
      csrfSecret: "csrf-secret-123",
      lastActivityAt: new Date(Date.now() - 3600000),
      expiresAt: new Date(Date.now() - 300000),
      isRevoked: false,
    });

    const req = new Request("http://localhost:3001/api/v1/auth/me", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
    });

    const result = await validateSession(req);
    assert.equal(result.user, null);
    assert.equal(result.error, "SESSION_EXPIRED");
  });

  test("8. Logout invalidates session in DB and clears cookies", async () => {
    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    const dummyReq = new Request("http://localhost:3001");
    const { rawSessionToken, csrfToken } = await createSession(
      user!._id,
      "patient",
      dummyReq
    );

    const logoutReq = new NextRequest("http://localhost:3001/api/v1/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${rawSessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
    });

    const logoutRes = await logoutHandler(logoutReq);
    assert.equal(logoutRes.status, 200);

    const setCookies = logoutRes.headers.getSetCookie();
    assert.ok(setCookies.some((c) => c.includes("Max-Age=0")));

    // Verify session revoked in DB
    const sessionInDb = await Session.findOne({ tokenHash: hashToken(rawSessionToken) });
    assert.equal(sessionInDb!.isRevoked, true);

    // Subsequent /me call must be rejected
    const meReq = new NextRequest("http://localhost:3001/api/v1/auth/me", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${rawSessionToken}` },
    });
    const meRes = await meHandler(meReq);
    assert.equal(meRes.status, 401);
  });

  test("9. Missing or malformed cookies are rejected", async () => {
    const reqNoCookie = new NextRequest("http://localhost:3001/api/v1/auth/me");
    const resNoCookie = await meHandler(reqNoCookie);
    assert.equal(resNoCookie.status, 401);

    const reqBadCookie = new NextRequest("http://localhost:3001/api/v1/auth/me", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=invalid-garbage-token-xyz` },
    });
    const resBadCookie = await meHandler(reqBadCookie);
    assert.equal(resBadCookie.status, 401);
  });

  test("10. Inactive user is rejected during challenge and session validation", async () => {
    // Challenge for inactive user
    const challengeReq = new NextRequest("http://localhost:3001/api/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "inactive.user@sbx" }),
    });
    const challengeRes = await challengeHandler(challengeReq);
    assert.equal(challengeRes.status, 403);
    const body = await challengeRes.json();
    assert.equal(body.error.code, "ACCOUNT_INACTIVE");

    // Session validation for deactivated account
    const inactiveUser = await User.findOne({ abhaAddress: "inactive.user@sbx" });
    const dummyReq = new Request("http://localhost:3001");
    const { rawSessionToken } = await createSession(
      inactiveUser!._id,
      "patient",
      dummyReq
    );

    const validateReq = new Request("http://localhost:3001", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${rawSessionToken}` },
    });
    const result = await validateSession(validateReq);
    assert.equal(result.user, null);
    assert.equal(result.error, "USER_INACTIVE");
  });

  test("11. Cross-user session isolation guarantees principal boundaries", async () => {
    const patientUser = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    const doctorUser = await User.findOne({ abhaAddress: "dr.ananya@hpr.sbx" });

    const dummyReq = new Request("http://localhost:3001");
    const sessionPatient = await createSession(patientUser!._id, "patient", dummyReq);
    const sessionDoctor = await createSession(doctorUser!._id, "doctor", dummyReq);

    // Call /me as Patient
    const reqPatient = new NextRequest("http://localhost:3001/api/v1/auth/me", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionPatient.rawSessionToken}` },
    });
    const resPatient = await meHandler(reqPatient);
    const bodyPatient = await resPatient.json();
    assert.equal(bodyPatient.data.user.role, "patient");
    assert.equal(bodyPatient.data.user.name, "Rahul Verma");

    // Call /me as Doctor
    const reqDoctor = new NextRequest("http://localhost:3001/api/v1/auth/me", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionDoctor.rawSessionToken}` },
    });
    const resDoctor = await meHandler(reqDoctor);
    const bodyDoctor = await resDoctor.json();
    assert.equal(bodyDoctor.data.user.role, "doctor");
    assert.equal(bodyDoctor.data.user.name, "Dr. Ananya Sharma");
  });

  test("12. CSRF rejection on state-changing requests", async () => {
    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    const dummyReq = new Request("http://localhost:3001");
    const { rawSessionToken } = await createSession(user!._id, "patient", dummyReq);

    // State-changing POST without x-csrf-token header
    const reqWithoutCsrf = new NextRequest("http://localhost:3001/api/v1/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${rawSessionToken}`,
      },
    });

    const resWithoutCsrf = await logoutHandler(reqWithoutCsrf);
    assert.equal(resWithoutCsrf.status, 403);
    const bodyWithoutCsrf = await resWithoutCsrf.json();
    assert.equal(bodyWithoutCsrf.error.code, "CSRF_VERIFICATION_FAILED");

    // State-changing POST with tampered x-csrf-token
    const reqTamperedCsrf = new NextRequest("http://localhost:3001/api/v1/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${rawSessionToken}`,
        "x-csrf-token": "tampered-attacker-csrf-token",
      },
    });

    const resTampered = await logoutHandler(reqTamperedCsrf);
    assert.equal(resTampered.status, 403);
  });

  test("13. Rate limit enforcement stops rapid brute-force abuse", () => {
    const testKey = "test_rate_limit_key_ip";
    clearAllRateLimits();

    // 5 attempts allowed
    for (let i = 0; i < 5; i++) {
      const res = checkRateLimit(testKey, 5, 300000);
      assert.equal(res.allowed, true);
    }

    // 6th attempt must be rejected
    const blockedRes = checkRateLimit(testKey, 5, 300000);
    assert.equal(blockedRes.allowed, false);
    assert.equal(blockedRes.remaining, 0);
    assert.ok(blockedRes.resetInSeconds > 0);
  });

  test("14. Production mode strictly rejects mock OTP delivery shortcuts", async () => {
    // Simulate NODE_ENV = production temporarily
    const originalEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";

    try {
      const req = new NextRequest("http://localhost:3001/api/v1/auth/mock-otp?challengeId=some-id");
      const res = await mockOtpHandler(req);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, "NOT_FOUND");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    }
  });
});
