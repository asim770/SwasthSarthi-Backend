import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { seedDemoIdentities } from "@/lib/db/seed";
import { User } from "@/lib/db/models/User";
import { POST as signupHandler } from "@/app/api/v1/auth/signup/route";
import { POST as verifyEmailHandler } from "@/app/api/v1/auth/verify-email/route";
import { POST as loginHandler } from "@/app/api/v1/auth/login/route";
import { GET as getPatientHandler } from "@/app/api/v1/patients/[id]/route";
import { GET as getPatientByPatientIdHandler } from "@/app/api/v1/patients/by-patient-id/[patientId]/route";
import { GET as getPatientInfoHandler } from "@/app/api/v1/patients/[id]/info/route";
import { GET as listPatientsHandler } from "@/app/api/v1/patients/route";
import { GET as getRecordsHandler } from "@/app/api/v1/records/route";
import { NextRequest } from "next/server";

describe("SwasthSaarthi — Patient Unique ID Auth & Info Fetching Suite", () => {
  before(async () => {
    await connectToDatabase();
    await seedDemoIdentities();
  });

  after(async () => {
    // Clean up test user created during tests
    await User.deleteMany({ email: /test.*@authexample\.com/ });
  });

  test("1. Patient signup assigns a unique Patient ID (PID-XXXXXXXX) and creates session", async () => {
    const testEmail = `test.patient.${Date.now()}@authexample.com`;
    const signupReq = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Dev Patient",
        email: testEmail,
        password: "SecurePassword123!",
        phone: "+91-9123456789",
        gender: "Female",
        dateOfBirth: "1996-08-20",
      }),
    });

    const res = await signupHandler(signupReq);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.patientId);
    assert.match(body.data.patientId, /^(PID-\d+|SS-PAT-\d+)$/);
    assert.equal(body.data.user.email, testEmail);
    assert.equal(body.data.user.name, "Dev Patient");
    assert.equal(body.data.user.role, "patient");

    // Complete email verification to activate account and establish session
    const verifyReq = new NextRequest("http://localhost:3000/api/v1/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: body.data.challengeId,
        otp: body.data.devOtp || "123456",
        email: testEmail,
      }),
    });
    const verifyRes = await verifyEmailHandler(verifyReq);
    assert.equal(verifyRes.status, 200);
    const verifyBody = await verifyRes.json();
    assert.ok(verifyBody.data.csrfToken);

    // Verify cookies set
    const setCookie = verifyRes.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.ok(setCookie.includes("ss_session="));
  });

  test("2. Signup with duplicate email is rejected with 409 Conflict", async () => {
    const duplicateEmail = "rahul.verma@synthetic.demo"; // Seeded email
    const req = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Another Rahul",
        email: duplicateEmail,
        password: "NewPassword123!",
      }),
    });

    const res = await signupHandler(req);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "EMAIL_ALREADY_EXISTS");
  });

  test("3. Login using unique Patient ID and password succeeds", async () => {
    // Rahul Verma has seeded patientId 'PID-10000001' and password 'Password123!'
    const req = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "PID-10000001",
        password: "Password123!",
      }),
    });

    const res = await loginHandler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.user.patientId, "PID-10000001");
    assert.equal(body.data.user.name, "Rahul Verma");
    assert.ok(body.data.csrfToken);
  });

  test("4. Login using registered email and password succeeds", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "rahul.verma@synthetic.demo",
        password: "Password123!",
      }),
    });

    const res = await loginHandler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.user.patientId, "PID-10000001");
    assert.equal(body.data.user.email, "rahul.verma@synthetic.demo");
  });

  test("5. Login with incorrect password returns 401 Unauthorized", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "PID-10000001",
        password: "WrongPassword999!",
      }),
    });

    const res = await loginHandler(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_CREDENTIALS");
  });

  test("6. Fetching patient profile through unique Patient ID (PID-10000001)", async () => {
    // Log in as Rahul Verma to get session cookie
    const loginReq = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "PID-10000001",
        password: "Password123!",
      }),
    });
    const loginRes = await loginHandler(loginReq);
    const cookies = loginRes.headers.get("set-cookie") || "";

    // GET /api/v1/patients/PID-10000001
    const getReq = new NextRequest("http://localhost:3000/api/v1/patients/PID-10000001", {
      headers: { cookie: cookies },
    });

    const res = await getPatientHandler(getReq, {
      params: Promise.resolve({ id: "PID-10000001" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.patientId, "PID-10000001");
    assert.equal(body.data.name, "Rahul Verma");
    assert.equal(body.data.email, "rahul.verma@synthetic.demo");
    assert.equal(body.data.abhaAddress, "rahul.verma@sbx");
  });

  test("7. Fetching via dedicated route /api/v1/patients/by-patient-id/PID-10000001", async () => {
    const loginReq = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "PID-10000001",
        password: "Password123!",
      }),
    });
    const loginRes = await loginHandler(loginReq);
    const cookies = loginRes.headers.get("set-cookie") || "";

    const req = new NextRequest("http://localhost:3000/api/v1/patients/by-patient-id/PID-10000001", {
      headers: { cookie: cookies },
    });

    const res = await getPatientByPatientIdHandler(req, {
      params: Promise.resolve({ patientId: "PID-10000001" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.patientId, "PID-10000001");
    assert.equal(body.data.name, "Rahul Verma");
  });

  test("8. Fetching all info via /api/v1/patients/PID-10000001/info returns records, profile, and consents", async () => {
    const loginReq = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "PID-10000001",
        password: "Password123!",
      }),
    });
    const loginRes = await loginHandler(loginReq);
    const cookies = loginRes.headers.get("set-cookie") || "";

    const req = new NextRequest("http://localhost:3000/api/v1/patients/PID-10000001/info", {
      headers: { cookie: cookies },
    });

    const res = await getPatientInfoHandler(req, {
      params: Promise.resolve({ id: "PID-10000001" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.patient.patientId, "PID-10000001");
    assert.ok(body.data.recordsSummary);
    assert.ok(Array.isArray(body.data.clinicalRecords));
    assert.ok(Array.isArray(body.data.consents));
  });

  test("9. Querying records via /api/v1/records?patientId=PID-10000001 works seamlessly", async () => {
    const loginReq = new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "PID-10000001",
        password: "Password123!",
      }),
    });
    const loginRes = await loginHandler(loginReq);
    const cookies = loginRes.headers.get("set-cookie") || "";

    const req = new NextRequest("http://localhost:3000/api/v1/records?patientId=PID-10000001", {
      headers: { cookie: cookies },
    });

    const res = await getRecordsHandler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);
  });
});
