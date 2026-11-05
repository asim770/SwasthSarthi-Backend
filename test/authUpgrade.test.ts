import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { connectToDatabase } from "../src/lib/db/connect";
import { User } from "../src/lib/db/models/User";
import { AuthChallenge } from "../src/lib/db/models/AuthChallenge";
import { Session } from "../src/lib/db/models/Session";
import { POST as googleAuthHandler } from "../src/app/api/v1/auth/google/route";
import { POST as signupHandler } from "../src/app/api/v1/auth/signup/route";
import { POST as loginHandler } from "../src/app/api/v1/auth/login/route";
import { POST as verifyEmailHandler } from "../src/app/api/v1/auth/verify-email/route";
import { POST as forgotPasswordHandler } from "../src/app/api/v1/auth/forgot-password/route";
import { POST as resetPasswordHandler } from "../src/app/api/v1/auth/reset-password/route";
import { POST as changePasswordHandler } from "../src/app/api/v1/auth/change-password/route";
import { POST as linkGoogleHandler } from "../src/app/api/v1/auth/link-google/route";
import { NextRequest } from "next/server";

describe("SwasthSaarthi — Authentication System Upgrade Suite", () => {
  before(async () => {
    await connectToDatabase();
    // Clean up test-specific accounts
    await User.deleteMany({
      email: {
        $in: [
          "test.google.patient@example.com",
          "test.manual.patient@example.com",
          "test.linking.patient@example.com",
        ],
      },
    });
  });

  test("1. Google OAuth Registration automatically creates account and assigns unique Patient ID", async () => {
    const mockToken = "mock-google-token:goog999888:test.google.patient@example.com";
    const req = new NextRequest("http://localhost:3000/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: mockToken,
        mode: "register",
      }),
    });

    const res = await googleAuthHandler(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.user.patientId, "Patient ID must be assigned");
    assert.ok(
      body.data.user.patientId.startsWith("SS-PAT-") || body.data.user.patientId.startsWith("PID-"),
      "Patient ID must follow SS-PAT or PID format"
    );
    assert.equal(body.data.user.email, "test.google.patient@example.com");
    assert.deepEqual(body.data.user.authProviders, ["google"]);
    assert.equal(body.data.user.accountStatus, "active");
    assert.equal(body.data.user.isEmailVerified, true);

    // Verify persisted record in MongoDB
    const userDoc = await User.findOne({ email: "test.google.patient@example.com" });
    assert.ok(userDoc);
    assert.equal(userDoc?.googleSubject, "goog999888");
  });

  test("2. Google OAuth Login identifies existing account using Google subject identifier", async () => {
    const mockToken = "mock-google-token:goog999888:test.google.patient@example.com";
    const req = new NextRequest("http://localhost:3000/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: mockToken,
        mode: "login",
      }),
    });

    const res = await googleAuthHandler(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.user.email, "test.google.patient@example.com");
  });

  test("3. Google OAuth Login returns 404 ACCOUNT_NOT_FOUND when identity is unregistered and mode is login", async () => {
    const mockToken = "mock-google-token:unknown999:unregistered@example.com";
    const req = new NextRequest("http://localhost:3000/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: mockToken,
        mode: "login",
      }),
    });

    const res = await googleAuthHandler(req);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "ACCOUNT_NOT_FOUND");
  });

  let manualPatientId = "";
  let emailVerificationChallengeId = "";
  let emailVerificationOtp = "";

  test("4. Manual Email Registration validates password strength and creates pending account with Patient ID", async () => {
    // 4a. Rejects weak password
    const weakReq = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Aman Verma",
        email: "test.manual.patient@example.com",
        password: "weak", // < 8 chars
        phone: "+91-9876543220",
      }),
    });
    const weakRes = await signupHandler(weakReq);
    assert.equal(weakRes.status, 400);

    // 4b. Valid registration
    const validReq = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Aman Verma",
        email: "test.manual.patient@example.com",
        password: "StrongPassword123!",
        confirmPassword: "StrongPassword123!",
        phone: "+91-9876543220",
      }),
    });

    const res = await signupHandler(validReq);
    assert.equal(res.status, 201);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.requiresVerification, true);
    assert.ok(body.data.patientId);
    manualPatientId = body.data.patientId;
    emailVerificationChallengeId = body.data.challengeId;
    emailVerificationOtp = body.data.devOtp || "123456";

    // Verify account status is pending_verification
    const pendingUser = await User.findOne({ email: "test.manual.patient@example.com" });
    assert.ok(pendingUser);
    assert.equal(pendingUser?.accountStatus, "pending_verification");
    assert.equal(pendingUser?.isEmailVerified, false);
  });

  test("5. Unverified manual account cannot log in before email verification", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "test.manual.patient@example.com",
        password: "StrongPassword123!",
      }),
    });

    const res = await loginHandler(req);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, "EMAIL_VERIFICATION_REQUIRED");
  });

  test("6. Email verification OTP activates account and establishes session", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: emailVerificationChallengeId,
        otp: emailVerificationOtp,
        email: "test.manual.patient@example.com",
      }),
    });

    const res = await verifyEmailHandler(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.user.accountStatus, "active");
    assert.equal(body.data.user.isEmailVerified, true);
    assert.equal(body.data.patientId, manualPatientId);

    // Verify in database
    const activeUser = await User.findOne({ email: "test.manual.patient@example.com" });
    assert.equal(activeUser?.accountStatus, "active");
    assert.equal(activeUser?.isEmailVerified, true);
  });

  test("7. Patient can log in using unique Patient ID + password", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: manualPatientId,
        password: "StrongPassword123!",
      }),
    });

    const res = await loginHandler(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.user.patientId, manualPatientId);
  });

  test("8. Patient can log in using registered Email + password", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "test.manual.patient@example.com",
        password: "StrongPassword123!",
      }),
    });

    const res = await loginHandler(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.user.patientId, manualPatientId);
  });

  test("9. Duplicate registration with same normalized email is rejected with 409", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Duplicate User",
        email: "TEST.MANUAL.PATIENT@EXAMPLE.COM", // uppercase to test normalization
        password: "AnotherPassword123!",
      }),
    });

    const res = await signupHandler(req);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, "EMAIL_ALREADY_EXISTS");
  });

  test("10. Forgot Password workflow sends OTP and allows password reset", async () => {
    const targetPid = manualPatientId || "PID-10000001";
    // 10a. Request password reset
    const forgotReq = new NextRequest("http://localhost:3000/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: targetPid,
      }),
    });

    const forgotRes = await forgotPasswordHandler(forgotReq);
    assert.equal(forgotRes.status, 200);
    const forgotBody = await forgotRes.json();
    assert.ok(forgotBody.data.challengeId);

    const resetOtp = forgotBody.data.devOtp || "123456";

    // 10b. Complete password reset
    const resetReq = new NextRequest("http://localhost:3000/api/v1/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: forgotBody.data.challengeId,
        otp: resetOtp,
        newPassword: "BrandNewPassword2026!",
      }),
    });

    let resetRes: any;
    try {
      resetRes = await resetPasswordHandler(resetReq);
    } catch (e) {
      console.error("resetPasswordHandler threw:", e);
    }
    if (resetRes?.status !== 200) {
      console.error("resetRes status:", resetRes?.status, await resetRes?.json());
    }
    assert.equal(resetRes.status, 200);

    // 10c. Old password is now rejected
    const oldLoginReq = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: targetPid,
        password: "StrongPassword123!",
      }),
    });
    const oldLoginRes = await loginHandler(oldLoginReq);
    assert.equal(oldLoginRes.status, 401);

    // 10d. New password succeeds
    const newLoginReq = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: targetPid,
        password: "BrandNewPassword2026!",
      }),
    });
    const newLoginRes = await loginHandler(newLoginReq);
    assert.equal(newLoginRes.status, 200);
  });
});
