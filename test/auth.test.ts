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
import { GET as channelsHandler } from "@/app/api/v1/auth/channels/route";
import {
  ResendEmailProvider,
  Msg91SmsProvider,
  MockOtpDeliveryProvider,
  otpChallengeService,
  normalizePhoneNumber,
  maskPhoneNumber,
  maskEmailAddress,
  maskIdentifier,
} from "@/lib/auth/otp";
import { verifyAuditChainIntegrity, logAuditEvent } from "@/lib/dal/audit";
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

  // 1. Normalization & Masking
  test("15. Phone and email normalization and masking protect PII", () => {
    const norm1 = normalizePhoneNumber("+91 98765 43210");
    assert.equal(norm1.isValid, true);
    assert.equal(norm1.e164, "+919876543210");
    assert.equal(norm1.digitsOnly, "919876543210");

    const norm2 = normalizePhoneNumber("9876543210");
    assert.equal(norm2.isValid, true);
    assert.equal(norm2.e164, "+919876543210");
    assert.equal(norm2.digitsOnly, "919876543210");

    const invalidPhone = normalizePhoneNumber("12345");
    assert.equal(invalidPhone.isValid, false);

    const maskedPhone = maskPhoneNumber("+919876543210");
    assert.ok(!maskedPhone.includes("9876543210"));
    assert.ok(maskedPhone.includes("****"));

    const maskedEmail = maskEmailAddress("rahul.verma@example.com");
    assert.ok(!maskedEmail.includes("rahul.verma"));
    assert.match(maskedEmail, /^r\*+a@example\.com$/);

    const maskedId = maskIdentifier("rahul.verma@sbx");
    assert.ok(!maskedId.includes("rahul.verma"));
    assert.ok(maskedId.includes("@sbx"));

    const maskedAbha = maskIdentifier("32-8492-1920-4491");
    assert.equal(maskedAbha, "32-****-****-4491");
  });

  // 2. Resend Email Delivery Provider Adapter Unit Tests
  test("16. ResendEmailProvider sends verified payload and handles API success", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    const mockFetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body));

      return new Response(JSON.stringify({ id: "resend_msg_test_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const provider = new ResendEmailProvider({
      apiKey: "re_test_key_valid",
      fromEmail: "onboarding@resend.dev",
      fetcher: mockFetcher,
    });

    assert.equal(provider.isConfigured(), true);

    const result = await provider.sendOtp({
      destination: "patient@example.com",
      otp: "654321",
      ttlSeconds: 300,
      maskedDestination: "p***t@example.com",
      userName: "Rahul Verma",
    });

    assert.equal(result.success, true);
    assert.equal(result.messageId, "resend_msg_test_123");
    assert.equal(result.channel, "email");
    assert.equal(capturedUrl, "https://api.resend.com/emails");
    assert.equal(capturedHeaders.Authorization, "Bearer re_test_key_valid");
    assert.deepEqual(capturedBody.to, ["patient@example.com"]);
    assert.equal(capturedBody.from, "onboarding@resend.dev");
    assert.ok(capturedBody.text.includes("654321"));
    assert.ok(capturedBody.html.includes("654321"));
    assert.ok(capturedBody.html.includes("SwasthSaarthi"));
  });

  test("17. ResendEmailProvider handles errors and timeouts gracefully without exposing keys", async () => {
    const unauthorizedFetcher: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ message: "API key is invalid", name: "validation_error" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider401 = new ResendEmailProvider({
      apiKey: "re_invalid",
      fetcher: unauthorizedFetcher,
    });

    const res401 = await provider401.sendOtp({
      destination: "patient@example.com",
      otp: "123456",
      ttlSeconds: 300,
      maskedDestination: "p***t@example.com",
    });

    assert.equal(res401.success, false);
    assert.ok(res401.error?.includes("Resend delivery failed"));
    assert.ok(!res401.error?.includes("re_invalid"));

    const timeoutFetcher: typeof fetch = async () => {
      const err = new Error("Request timed out");
      err.name = "TimeoutError";
      throw err;
    };

    const providerTimeout = new ResendEmailProvider({
      apiKey: "re_test",
      fetcher: timeoutFetcher,
    });

    const resTimeout = await providerTimeout.sendOtp({
      destination: "patient@example.com",
      otp: "123456",
      ttlSeconds: 300,
      maskedDestination: "p***t@example.com",
    });

    assert.equal(resTimeout.success, false);
    assert.ok(resTimeout.error?.includes("timed out"));
  });

  test("18. ResendEmailProvider fails safely when unconfigured", async () => {
    const unconfigured = new ResendEmailProvider({ apiKey: "" });
    assert.equal(unconfigured.isConfigured(), false);

    const res = await unconfigured.sendOtp({
      destination: "test@example.com",
      otp: "111111",
      ttlSeconds: 300,
      maskedDestination: "t***t@example.com",
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes("not configured"));
  });

  // 3. MSG91 SMS Delivery Provider Adapter Unit Tests
  test("19. Msg91SmsProvider dispatches international formatted phone and OTP", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    const mockFetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body));

      return new Response(JSON.stringify({ type: "success", message: "msg91_req_884920" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const provider = new Msg91SmsProvider({
      authKey: "msg91_secret_auth_key",
      templateId: "template_swasth_otp",
      fetcher: mockFetcher,
    });

    assert.equal(provider.isConfigured(), true);

    const result = await provider.sendOtp({
      destination: "+91 98765-43210",
      otp: "987123",
      ttlSeconds: 300,
      maskedDestination: "+91-98****4210",
      userName: "Rahul Verma",
    });

    assert.equal(result.success, true);
    assert.equal(result.messageId, "msg91_req_884920");
    assert.equal(result.channel, "sms");

    const parsedUrl = new URL(capturedUrl);
    assert.equal(parsedUrl.pathname, "/api/v5/otp");
    assert.equal(parsedUrl.searchParams.get("template_id"), "template_swasth_otp");
    assert.equal(parsedUrl.searchParams.get("mobile"), "919876543210");
    assert.equal(parsedUrl.searchParams.get("otp"), "987123");
    assert.equal(parsedUrl.searchParams.get("otp_expiry"), "5");
    assert.equal(capturedHeaders.authkey, "msg91_secret_auth_key");
    assert.equal(capturedBody.otp, "987123");
  });

  test("20. Msg91SmsProvider rejects malformed phone and handles provider errors", async () => {
    const provider = new Msg91SmsProvider({
      authKey: "valid_key",
      templateId: "valid_tmpl",
    });

    const badPhone = await provider.sendOtp({
      destination: "not-a-number",
      otp: "123456",
      ttlSeconds: 300,
      maskedDestination: "***",
    });
    assert.equal(badPhone.success, false);
    assert.ok(badPhone.error?.includes("Phone number"));

    const errorFetcher: typeof fetch = async () => {
      return new Response(JSON.stringify({ type: "error", message: "Invalid template ID" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const providerWithError = new Msg91SmsProvider({
      authKey: "valid_key",
      templateId: "bad_tmpl",
      fetcher: errorFetcher,
    });

    const errorRes = await providerWithError.sendOtp({
      destination: "+919876543210",
      otp: "123456",
      ttlSeconds: 300,
      maskedDestination: "+91-98****3210",
    });

    assert.equal(errorRes.success, false);
    assert.ok(errorRes.error?.includes("MSG91 error"));
  });

  test("21. Msg91SmsProvider fails safely when unconfigured", async () => {
    const unconfigured = new Msg91SmsProvider({ authKey: "", templateId: "" });
    assert.equal(unconfigured.isConfigured(), false);

    const res = await unconfigured.sendOtp({
      destination: "+919876543210",
      otp: "111111",
      ttlSeconds: 300,
      maskedDestination: "+91-98****3210",
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes("not configured"));
  });

  // 4. End-to-End Multi-Channel OTP Login & Contact Verification Flow
  test("22. Full Email OTP verification flow establishes session and marks email verified", async () => {
    let deliveredEmailOtp = "";

    const mockEmailProvider = new ResendEmailProvider({
      apiKey: "re_mock_test_key",
      fromEmail: "onboarding@resend.dev",
      fetcher: async (input, init) => {
        const body = JSON.parse(String(init?.body));
        const match = body.text.match(/verification code for SwasthSaarthi is:\s*(\d{6})/);
        if (match) {
          deliveredEmailOtp = match[1];
        }
        return new Response(JSON.stringify({ id: "resend_test_delivered_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    otpChallengeService.setEmailProvider(mockEmailProvider);

    const challengeReq = new NextRequest("http://localhost:3001/api/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "rahul.verma@sbx",
        channel: "email",
        contact: "rahul.verma@testmail.com",
      }),
    });

    const challengeRes = await challengeHandler(challengeReq);
    assert.equal(challengeRes.status, 201);
    const challengeBody = await challengeRes.json();

    assert.equal(challengeBody.success, true);
    assert.equal(challengeBody.data.channel, "email");
    assert.ok(challengeBody.data.challengeId);
    assert.ok(challengeBody.data.maskedDestination.includes("@testmail.com"));
    assert.match(deliveredEmailOtp, /^\d{6}$/);

    const storedChallenge = await AuthChallenge.findOne({
      challengeId: challengeBody.data.challengeId,
    });
    assert.ok(storedChallenge);
    assert.equal(storedChallenge.channel, "email");
    assert.equal(storedChallenge.devOtp, undefined);
    assert.ok(storedChallenge.otpHash.length === 64);

    const verifyReq = new NextRequest("http://localhost:3001/api/v1/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challengeBody.data.challengeId,
        otp: deliveredEmailOtp,
      }),
    });

    const verifyRes = await verifyHandler(verifyReq);
    assert.equal(verifyRes.status, 200);
    const verifyBody = await verifyRes.json();

    assert.equal(verifyBody.success, true);
    assert.equal(verifyBody.data.contactVerified, true);
    assert.equal(verifyBody.data.user.isEmailVerified, true);
    assert.ok(verifyBody.data.csrfToken);

    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    assert.equal(user?.isEmailVerified, true);
    assert.ok(user?.emailVerifiedAt);
  });

  test("23. Full SMS OTP verification flow establishes session and marks phone verified", async () => {
    let deliveredSmsOtp = "";

    const mockSmsProvider = new Msg91SmsProvider({
      authKey: "msg91_mock_auth_key",
      templateId: "swasth_sms_tmpl",
      fetcher: async (input) => {
        const url = new URL(String(input));
        deliveredSmsOtp = url.searchParams.get("otp") || "";
        return new Response(JSON.stringify({ type: "success", message: "msg91_test_ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    otpChallengeService.setSmsProvider(mockSmsProvider);

    const challengeReq = new NextRequest("http://localhost:3001/api/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "rahul.verma@sbx",
        channel: "sms",
        contact: "+91 98765 43210",
      }),
    });

    const challengeRes = await challengeHandler(challengeReq);
    assert.equal(challengeRes.status, 201);
    const challengeBody = await challengeRes.json();

    assert.equal(challengeBody.success, true);
    assert.equal(challengeBody.data.channel, "sms");
    assert.match(deliveredSmsOtp, /^\d{6}$/);

    const verifyReq = new NextRequest("http://localhost:3001/api/v1/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challengeBody.data.challengeId,
        otp: deliveredSmsOtp,
      }),
    });

    const verifyRes = await verifyHandler(verifyReq);
    assert.equal(verifyRes.status, 200);
    const verifyBody = await verifyRes.json();

    assert.equal(verifyBody.success, true);
    assert.equal(verifyBody.data.contactVerified, true);
    assert.equal(verifyBody.data.user.isPhoneVerified, true);

    const user = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
    assert.equal(user?.isPhoneVerified, true);
    assert.ok(user?.phoneVerifiedAt);
  });

  // 5. Challenge Security & Abuse Prevention
  test("24. Correct OTP is accepted exactly once; replay attempts are rejected", async () => {
    const mockProvider = new MockOtpDeliveryProvider();
    otpChallengeService.setMockProvider(mockProvider);

    const challengeReq = new NextRequest("http://localhost:3001/api/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "rahul.verma@sbx", channel: "mock" }),
    });

    const challengeRes = await challengeHandler(challengeReq);
    const challengeBody = await challengeRes.json();
    const otp = mockProvider.getLastSentOtp();

    const res1 = await verifyHandler(
      new NextRequest("http://localhost:3001/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: challengeBody.data.challengeId, otp }),
      })
    );
    assert.equal(res1.status, 200);

    const res2 = await verifyHandler(
      new NextRequest("http://localhost:3001/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: challengeBody.data.challengeId, otp }),
      })
    );
    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.error.code, "CHALLENGE_ALREADY_CONSUMED");
  });

  test("25. Resend cooldown enforces cooldown period before new OTP can be requested", async () => {
    const mockProvider = new MockOtpDeliveryProvider();
    otpChallengeService.setMockProvider(mockProvider);

    const req1 = new NextRequest("http://localhost:3001/api/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "rahul.verma@sbx", channel: "mock" }),
    });
    const res1 = await challengeHandler(req1);
    assert.equal(res1.status, 201);

    const req2 = new NextRequest("http://localhost:3001/api/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "rahul.verma@sbx", channel: "mock" }),
    });
    const res2 = await challengeHandler(req2);
    assert.equal(res2.status, 429);
    const body2 = await res2.json();
    assert.equal(body2.error.code, "RESEND_COOLDOWN_ACTIVE");
    assert.ok(body2.error.message.includes("wait"));
  });

  test("26. Provider failure does not silently switch to mock delivery", async () => {
    const failingResend = new ResendEmailProvider({
      apiKey: "re_test_failing",
      fetcher: async () => {
        return new Response(JSON.stringify({ message: "Resend account suspended" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    otpChallengeService.setEmailProvider(failingResend);

    const req = new NextRequest("http://localhost:3001/api/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "rahul.verma@sbx",
        channel: "email",
        contact: "test@example.com",
      }),
    });

    const res = await challengeHandler(req);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, "PROVIDER_DELIVERY_ERROR");
  });

  test("27. GET /api/v1/auth/channels returns configured delivery channels", async () => {
    const req = new NextRequest("http://localhost:3001/api/v1/auth/channels");
    const res = await channelsHandler(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.success, true);
    assert.ok(body.data.channels);
    assert.equal(body.data.abdmStatus, "SIMULATED_DEMO_ONLY");
    assert.ok(body.data.channels.some((c: any) => c.id === "email"));
    assert.ok(body.data.channels.some((c: any) => c.id === "sms"));
  });

  test("28. Audit chain integrity verifies all security events without secret leakage", async () => {
    const { AuditLog } = await import("@/lib/db/models/AuditLog");
    const recentOtpLogs = await AuditLog.find({ action: { $regex: /^AUTH_OTP_/ } }).sort({
      sequenceNumber: 1,
    });
    assert.ok(recentOtpLogs.length > 0);

    for (const log of recentOtpLogs) {
      const serialized = JSON.stringify(log);
      assert.ok(!serialized.includes("re_test"));
      assert.ok(!serialized.includes("msg91_mock"));
      assert.ok(!serialized.includes("password"));
    }

    const logA = await logAuditEvent({
      action: "AUTH_OTP_AUDIT_VERIFY_A",
      outcome: "ALLOWED",
      targetResourceType: "AuthChallenge",
      metadata: { demoMode: true },
    });
    const logB = await logAuditEvent({
      action: "AUTH_OTP_AUDIT_VERIFY_B",
      outcome: "ALLOWED",
      targetResourceType: "AuthChallenge",
      metadata: { demoMode: true },
    });

    assert.ok(logA && logB);
    const check = await verifyAuditChainIntegrity(logA.sequenceNumber!, logB.sequenceNumber!);
    assert.equal(check.valid, true);
    assert.equal(check.totalVerified, 2);
  });
});

