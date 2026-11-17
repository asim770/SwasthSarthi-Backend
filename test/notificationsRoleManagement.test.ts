import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { User, IUser } from "@/lib/db/models/User";
import { Notification } from "@/lib/db/models/Notification";
import {
  createNotification,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  sendHealthcareEventNotification,
} from "@/lib/dal/notifications";
import { listUsersForAdmin, updateUserStatus } from "@/lib/dal/admin";
import { POST as signupHandler } from "@/lib/../app/api/v1/auth/signup/route";
import { NextRequest } from "next/server";
import { AuthenticatedPrincipal } from "@/lib/dal/types";
import { ForbiddenError } from "@/lib/dal/errors";

describe("SwasthSaarthi — Role-Based Notification Ownership & User Management Suite", () => {
  let adminUser: IUser;
  let otherAdminUser: IUser;
  let patientUser: IUser;
  let otherPatientUser: IUser;
  let doctorUser: IUser;
  let otherDoctorUser: IUser;
  let labUser: IUser;
  let otherLabUser: IUser;
  let pharmacyUser: IUser;
  let otherPharmacyUser: IUser;

  let adminPrincipal: AuthenticatedPrincipal;
  let otherAdminPrincipal: AuthenticatedPrincipal;
  let patientPrincipal: AuthenticatedPrincipal;
  let otherPatientPrincipal: AuthenticatedPrincipal;
  let doctorPrincipal: AuthenticatedPrincipal;
  let otherDoctorPrincipal: AuthenticatedPrincipal;
  let labPrincipal: AuthenticatedPrincipal;
  let otherLabPrincipal: AuthenticatedPrincipal;
  let pharmacyPrincipal: AuthenticatedPrincipal;
  let otherPharmacyPrincipal: AuthenticatedPrincipal;

  const testSuffix = Date.now().toString().slice(-6);

  before(async () => {
    await connectToDatabase();

    // Clean up test data
    await User.deleteMany({ email: new RegExp(`test_notif_${testSuffix}`) });
    await Notification.deleteMany({ idempotencyKey: new RegExp(`test-notif-${testSuffix}`) });

    // Create Test Admin
    adminUser = await User.create({
      name: "Admin Governance Officer",
      email: `test_notif_${testSuffix}_admin@hospital.org`,
      role: "admin",
      isActive: true,
      phone: "+91-9876540001",
      abhaId: `91-9000-0001-${testSuffix}`,
      abhaAddress: `admin_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    otherAdminUser = await User.create({
      name: "Second Admin",
      email: `test_notif_${testSuffix}_admin2@hospital.org`,
      role: "admin",
      isActive: true,
      phone: "+91-9876540002",
      abhaId: `91-9000-0002-${testSuffix}`,
      abhaAddress: `admin2_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    // Create Test Patient
    patientUser = await User.create({
      name: "Rohan Verma",
      email: `test_notif_${testSuffix}_patient@example.com`,
      patientId: `SS-PAT-${testSuffix}1`,
      role: "patient",
      isActive: true,
      phone: "+91-9876540003",
      abhaId: `91-9000-0003-${testSuffix}`,
      abhaAddress: `rohan_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    otherPatientUser = await User.create({
      name: "Sunita Roy",
      email: `test_notif_${testSuffix}_patient2@example.com`,
      patientId: `SS-PAT-${testSuffix}2`,
      role: "patient",
      isActive: true,
      phone: "+91-9876540004",
      abhaId: `91-9000-0004-${testSuffix}`,
      abhaAddress: `sunita_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    // Create Test Doctor
    doctorUser = await User.create({
      name: "Dr. Ananya Sen",
      email: `test_notif_${testSuffix}_doc@hospital.org`,
      role: "doctor",
      isActive: true,
      facility: "AIIMS New Delhi",
      phone: "+91-9876540005",
      abhaId: `91-9000-0005-${testSuffix}`,
      abhaAddress: `dr_ananya_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    otherDoctorUser = await User.create({
      name: "Dr. Bikram Roy",
      email: `test_notif_${testSuffix}_doc2@hospital.org`,
      role: "doctor",
      isActive: true,
      facility: "Max Healthcare",
      phone: "+91-9876540006",
      abhaId: `91-9000-0006-${testSuffix}`,
      abhaAddress: `dr_bikram_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    // Create Test Laboratory
    labUser = await User.create({
      name: "PathCare Diagnostic Center",
      email: `test_notif_${testSuffix}_lab@lab.org`,
      role: "laboratory",
      isActive: true,
      facility: "PathCare Central Lab",
      phone: "+91-9876540007",
      abhaId: `91-9000-0007-${testSuffix}`,
      abhaAddress: `pathcare_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    otherLabUser = await User.create({
      name: "Metropolis Diagnostics",
      email: `test_notif_${testSuffix}_lab2@lab.org`,
      role: "laboratory",
      isActive: true,
      facility: "Metropolis Lab",
      phone: "+91-9876540008",
      abhaId: `91-9000-0008-${testSuffix}`,
      abhaAddress: `metropolis_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    // Create Test Pharmacy
    pharmacyUser = await User.create({
      name: "Apollo Pharmacy Store 1",
      email: `test_notif_${testSuffix}_pharm@pharmacy.org`,
      role: "pharmacy",
      isActive: true,
      facility: "Apollo Pharmacy",
      phone: "+91-9876540009",
      abhaId: `91-9000-0009-${testSuffix}`,
      abhaAddress: `apollo_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    otherPharmacyUser = await User.create({
      name: "MedPlus Pharmacy",
      email: `test_notif_${testSuffix}_pharm2@pharmacy.org`,
      role: "pharmacy",
      isActive: true,
      facility: "MedPlus Pharmacy",
      phone: "+91-9876540010",
      abhaId: `91-9000-0010-${testSuffix}`,
      abhaAddress: `medplus_${testSuffix}@sbx`,
      verificationStatus: "APPROVED",
    });

    // Build Principals
    adminPrincipal = { id: adminUser._id.toString(), role: "admin", name: adminUser.name };
    otherAdminPrincipal = { id: otherAdminUser._id.toString(), role: "admin", name: otherAdminUser.name };
    patientPrincipal = {
      id: patientUser._id.toString(),
      role: "patient",
      name: patientUser.name,
      patientId: patientUser.patientId,
      abhaAddress: patientUser.abhaAddress,
    };
    otherPatientPrincipal = {
      id: otherPatientUser._id.toString(),
      role: "patient",
      name: otherPatientUser.name,
      patientId: otherPatientUser.patientId,
      abhaAddress: otherPatientUser.abhaAddress,
    };
    doctorPrincipal = { id: doctorUser._id.toString(), role: "doctor", name: doctorUser.name, facility: doctorUser.facility };
    otherDoctorPrincipal = { id: otherDoctorUser._id.toString(), role: "doctor", name: otherDoctorUser.name, facility: otherDoctorUser.facility };
    labPrincipal = { id: labUser._id.toString(), role: "laboratory", name: labUser.name, facility: labUser.facility };
    otherLabPrincipal = { id: otherLabUser._id.toString(), role: "laboratory", name: otherLabUser.name, facility: otherLabUser.facility };
    pharmacyPrincipal = { id: pharmacyUser._id.toString(), role: "pharmacy", name: pharmacyUser.name, facility: pharmacyUser.facility };
    otherPharmacyPrincipal = { id: otherPharmacyUser._id.toString(), role: "pharmacy", name: otherPharmacyUser.name, facility: otherPharmacyUser.facility };
  });

  after(async () => {
    await User.deleteMany({ email: new RegExp(`test_notif_${testSuffix}`) });
    await Notification.deleteMany({ idempotencyKey: new RegExp(`test-notif-${testSuffix}`) });
  });

  // TEST 1: Doctor Registration
  it("Test 1: Doctor registration notifies authorized admins ONLY; patients, doctors, labs, and pharmacies do not receive it", async () => {
    // Register a new test doctor via signup API
    const regReq = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "doctor",
        name: "Dr. New Test Practitioner",
        email: `test_notif_${testSuffix}_newdoc@hospital.org`,
        password: "Password123#Secure",
        phone: "+91-9876540011",
        hospitalOrClinicName: "Fortis Hospital",
        specialization: "Cardiology",
      }),
    });

    const regRes = await signupHandler(regReq);
    assert.equal(regRes.status, 201);

    // Verify authorized admin receives registration notification
    const adminNotifs = await getNotifications(adminPrincipal);
    const newDocNotif = adminNotifs.notifications.find(
      (n) => n.title === "New Doctor Registration" && n.message.includes("Dr. New Test Practitioner")
    );
    assert.ok(newDocNotif, "Authorized admin must receive Doctor Registration notification");

    // Verify patients do NOT receive it
    const patientNotifs = await getNotifications(patientPrincipal);
    const patientHasDocNotif = patientNotifs.notifications.some(
      (n) => n.title === "New Doctor Registration"
    );
    assert.equal(patientHasDocNotif, false, "Patient must NOT receive doctor registration notification");

    // Verify other doctors do NOT receive it
    const otherDocNotifs = await getNotifications(doctorPrincipal);
    const docHasDocNotif = otherDocNotifs.notifications.some(
      (n) => n.title === "New Doctor Registration"
    );
    assert.equal(docHasDocNotif, false, "Unrelated doctor must NOT receive registration notification");

    // Verify laboratory does NOT receive it
    const labNotifs = await getNotifications(labPrincipal);
    const labHasDocNotif = labNotifs.notifications.some(
      (n) => n.title === "New Doctor Registration"
    );
    assert.equal(labHasDocNotif, false, "Laboratory must NOT receive registration notification");

    // Verify pharmacy does NOT receive it
    const pharmNotifs = await getNotifications(pharmacyPrincipal);
    const pharmHasDocNotif = pharmNotifs.notifications.some(
      (n) => n.title === "New Doctor Registration"
    );
    assert.equal(pharmHasDocNotif, false, "Pharmacy must NOT receive registration notification");
  });

  // TEST 2: Laboratory Registration
  it("Test 2: Laboratory registration goes only to authorized admins; unrelated roles do not receive it", async () => {
    const regReq = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "laboratory",
        name: "Thyrocare Central Hub",
        email: `test_notif_${testSuffix}_newlab@lab.org`,
        password: "Password123#Secure",
        phone: "+91-9876540012",
        organizationName: "Thyrocare Diagnostics",
      }),
    });

    const regRes = await signupHandler(regReq);
    assert.equal(regRes.status, 201);

    // Verify Admin received it
    const adminNotifs = await getNotifications(adminPrincipal);
    const labNotif = adminNotifs.notifications.find(
      (n) => n.title === "New Laboratory Registration" && n.message.includes("Thyrocare Diagnostics")
    );
    assert.ok(labNotif, "Admin must receive Laboratory Registration notification");

    // Verify Patient, Doctor, and Pharmacy do not receive it
    const patientNotifs = await getNotifications(patientPrincipal);
    assert.equal(patientNotifs.notifications.some((n) => n.title === "New Laboratory Registration"), false);

    const docNotifs = await getNotifications(doctorPrincipal);
    assert.equal(docNotifs.notifications.some((n) => n.title === "New Laboratory Registration"), false);

    const pharmNotifs = await getNotifications(pharmacyPrincipal);
    assert.equal(pharmNotifs.notifications.some((n) => n.title === "New Laboratory Registration"), false);
  });

  // TEST 3: Pharmacy Registration
  it("Test 3: Pharmacy registration goes only to authorized admins; unrelated roles do not receive it", async () => {
    const regReq = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "pharmacy",
        name: "MedLife Express Pharmacy",
        email: `test_notif_${testSuffix}_newpharm@pharmacy.org`,
        password: "Password123#Secure",
        phone: "+91-9876540013",
        organizationName: "MedLife Pharmacy",
      }),
    });

    const regRes = await signupHandler(regReq);
    assert.equal(regRes.status, 201);

    // Verify Admin received it
    const adminNotifs = await getNotifications(adminPrincipal);
    const pharmNotif = adminNotifs.notifications.find(
      (n) => n.title === "New Pharmacy Registration" && n.message.includes("MedLife Pharmacy")
    );
    assert.ok(pharmNotif, "Admin must receive Pharmacy Registration notification");

    // Verify Patient and Doctor do not receive it
    const patientNotifs = await getNotifications(patientPrincipal);
    assert.equal(patientNotifs.notifications.some((n) => n.title === "New Pharmacy Registration"), false);

    const docNotifs = await getNotifications(doctorPrincipal);
    assert.equal(docNotifs.notifications.some((n) => n.title === "New Pharmacy Registration"), false);
  });

  // TEST 4: Patient Medical Report
  it("Test 4: Patient medical report notification is delivered to the intended patient only", async () => {
    const reportResourceId = `DIAG-REP-${testSuffix}-001`;

    await sendHealthcareEventNotification({
      type: "LAB_REPORT_UPLOADED",
      targetPatientId: patientUser._id,
      resourceId: reportResourceId,
      facility: "PathCare Central Lab",
    });

    // Intended patient retrieves it
    const patientNotifs = await getNotifications(patientPrincipal);
    const reportNotif = patientNotifs.notifications.find(
      (n) => n.relatedResourceId === reportResourceId
    );
    assert.ok(reportNotif, "Intended patient must receive medical report notification");
    assert.equal(reportNotif?.category, "LAB_REPORT");
    assert.equal(reportNotif?.recipientId.toString(), patientUser._id.toString());

    // Another patient cannot retrieve it
    const otherPatientNotifs = await getNotifications(otherPatientPrincipal);
    assert.equal(
      otherPatientNotifs.notifications.some((n) => n.relatedResourceId === reportResourceId),
      false,
      "Another patient must NOT be able to retrieve the report notification"
    );

    // Unrelated users (unrelated doctor, unrelated lab) cannot retrieve it
    const docNotifs = await getNotifications(doctorPrincipal);
    assert.equal(docNotifs.notifications.some((n) => n.relatedResourceId === reportResourceId), false);
  });

  // TEST 5: Laboratory Test Request / Report Workflow
  it("Test 5: Laboratory test request / report workflow delivers to intended parties only", async () => {
    const labOrderId = `ORDER-${testSuffix}-101`;

    // Lab report created for patient
    await createNotification({
      recipientId: patientUser._id,
      recipientRole: "patient",
      category: "LAB_REPORT",
      title: "Diagnostic Report Ready",
      message: "A new laboratory report has been finalized by PathCare Central Lab.",
      relatedResourceId: labOrderId,
      relatedResourceType: "DiagnosticReport",
      idempotencyKey: `test-notif-${testSuffix}-lab-order-101`,
    });

    // Intended patient gets it
    const pNotifs = await getNotifications(patientPrincipal);
    assert.ok(pNotifs.notifications.some((n) => n.relatedResourceId === labOrderId));

    // Other laboratories do not receive patient's lab report notification
    const otherLabNotifs = await getNotifications(otherLabPrincipal);
    assert.equal(otherLabNotifs.notifications.some((n) => n.relatedResourceId === labOrderId), false);
  });

  // TEST 6: Prescription Delivery
  it("Test 6: Prescription notification goes to intended patient with clinical privacy preserved", async () => {
    const prescId = `PRESC-${testSuffix}-201`;

    await sendHealthcareEventNotification({
      type: "PRESCRIPTION_CREATED",
      targetPatientId: patientUser._id,
      resourceId: prescId,
      actorName: "Dr. Ananya Sen",
    });

    const pNotifs = await getNotifications(patientPrincipal);
    const prescNotif = pNotifs.notifications.find((n) => n.relatedResourceId === prescId);
    assert.ok(prescNotif, "Patient must receive prescription notification");
    assert.equal(prescNotif?.category, "PRESCRIPTION");
    // Verify privacy: does not leak medication drug names or dosages in preview
    assert.equal(prescNotif?.message.includes("mg"), false);
    assert.equal(prescNotif?.message.includes("Paracetamol"), false);

    // Other patient does not receive it
    const otherPNotifs = await getNotifications(otherPatientPrincipal);
    assert.equal(otherPNotifs.notifications.some((n) => n.relatedResourceId === prescId), false);
  });

  // TEST 7: Notification Read State Isolation
  it("Test 7: Marking one user's notification as read does not change another user's notification", async () => {
    // Create notification for patient 1
    const notif1 = await createNotification({
      recipientId: patientUser._id,
      recipientRole: "patient",
      category: "SECURITY",
      title: "Security Check Patient 1",
      message: "Two-factor verification enabled.",
      idempotencyKey: `test-notif-${testSuffix}-sec-1`,
    });

    // Create notification for patient 2
    const notif2 = await createNotification({
      recipientId: otherPatientUser._id,
      recipientRole: "patient",
      category: "SECURITY",
      title: "Security Check Patient 2",
      message: "Two-factor verification enabled.",
      idempotencyKey: `test-notif-${testSuffix}-sec-2`,
    });

    // Mark patient 1's notification as read
    await markNotificationAsRead(patientPrincipal, notif1.notification.notificationId);

    // Check DB states
    const updatedNotif1 = await Notification.findById(notif1.notification._id);
    const updatedNotif2 = await Notification.findById(notif2.notification._id);

    assert.equal(updatedNotif1?.isRead, true, "Patient 1 notification must be marked read");
    assert.equal(updatedNotif2?.isRead, false, "Patient 2 notification must remain unread");
  });

  // TEST 8: User Switching Isolation
  it("Test 8: User switching ensures patient notifications disappear and only doctor notifications are loaded", async () => {
    // Patient queries their notifications
    const patientResult = await getNotifications(patientPrincipal);
    assert.ok(patientResult.notifications.length > 0);
    // All items must belong to patient
    for (const n of patientResult.notifications) {
      assert.equal(n.recipientId.toString(), patientUser._id.toString());
    }

    // Now switch to Doctor: doctor queries their notifications
    const doctorResult = await getNotifications(doctorPrincipal);
    // None of patient's notifications should exist in doctor's inbox
    const patientNotifIds = new Set(patientResult.notifications.map((n) => n._id.toString()));
    for (const n of doctorResult.notifications) {
      assert.equal(patientNotifIds.has(n._id.toString()), false, "Doctor must not see patient notifications");
      assert.equal(n.recipientId.toString(), doctorUser._id.toString());
    }
  });

  // TEST 9: Authorization & IDOR Protection
  it("Test 9: Attempting to read, manage, or delete another user's notification is strictly rejected with 403 Forbidden", async () => {
    // Create notification for Doctor
    const docNotif = await createNotification({
      recipientId: doctorUser._id,
      recipientRole: "doctor",
      category: "CONSENT",
      title: "Consent Approval Notice",
      message: "Patient granted consultation access.",
      idempotencyKey: `test-notif-${testSuffix}-auth-check`,
    });

    // Patient tries to mark Doctor's notification as read -> must throw ForbiddenError
    await assert.rejects(
      async () => {
        await markNotificationAsRead(patientPrincipal, docNotif.notification.notificationId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as ForbiddenError).message, /Access denied/i);
        return true;
      }
    );

    // Patient tries to delete Doctor's notification -> must throw ForbiddenError
    await assert.rejects(
      async () => {
        await deleteNotification(patientPrincipal, docNotif.notification.notificationId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as ForbiddenError).message, /Access denied/i);
        return true;
      }
    );

    // Doctor can safely delete their own notification
    const deleteRes = await deleteNotification(doctorPrincipal, docNotif.notification.notificationId);
    assert.equal(deleteRes.success, true);
  });

  // TEST 10: Duplicate Prevention (Idempotency)
  it("Test 10: Processing the same event twice does not create duplicate notifications", async () => {
    const key = `test-notif-${testSuffix}-idempotent-key`;

    const first = await createNotification({
      recipientId: patientUser._id,
      recipientRole: "patient",
      category: "ONBOARDING",
      title: "Idempotent Event Notification",
      message: "Testing duplicate prevention.",
      idempotencyKey: key,
    });
    assert.equal(first.duplicate, false);

    const second = await createNotification({
      recipientId: patientUser._id,
      recipientRole: "patient",
      category: "ONBOARDING",
      title: "Idempotent Event Notification",
      message: "Testing duplicate prevention.",
      idempotencyKey: key,
    });
    assert.equal(second.duplicate, true);
    assert.equal(first.notification._id.toString(), second.notification._id.toString());

    // Verify only 1 record exists in DB
    const count = await Notification.countDocuments({ idempotencyKey: key });
    assert.equal(count, 1);
  });

  // TEST 11: Admin User Management Directory (Filtering, Search, Pagination)
  it("Test 11: Admin User Management supports server-side pagination, role filtering, status filtering, and search", async () => {
    // 1. Role filter: doctors only
    const doctorsList = await listUsersForAdmin(adminPrincipal, { role: "doctor", limit: 20 });
    assert.ok(doctorsList.users.length > 0);
    for (const u of doctorsList.users) {
      assert.equal(u.role, "doctor");
    }

    // 2. Role filter: patients only
    const patientsList = await listUsersForAdmin(adminPrincipal, { role: "patient", limit: 20 });
    assert.ok(patientsList.users.length > 0);
    for (const u of patientsList.users) {
      assert.equal(u.role, "patient");
    }

    // 3. Search by name or email
    const searchResult = await listUsersForAdmin(adminPrincipal, { search: `Rohan Verma` });
    assert.ok(searchResult.users.length > 0);
    assert.equal(searchResult.users[0].name, "Rohan Verma");

    // 4. Non-admin cannot access user directory
    await assert.rejects(async () => {
      await listUsersForAdmin(doctorPrincipal);
    }, ForbiddenError);
  });

  // TEST 12: Admin Account Status Modification & Self-Protection
  it("Test 12: Admin can suspend/reactivate accounts, but cannot modify their own active status", async () => {
    // Admin suspends a test doctor
    const updated = await updateUserStatus(adminPrincipal, doctorUser._id.toString(), false);
    assert.equal(updated.isActive, false);

    const doctorInDb = await User.findById(doctorUser._id);
    assert.equal(doctorInDb?.isActive, false);

    // Admin reactivates the doctor
    const reactivated = await updateUserStatus(adminPrincipal, doctorUser._id.toString(), true);
    assert.equal(reactivated.isActive, true);

    // Admin attempts to suspend themselves -> rejected with ForbiddenError
    await assert.rejects(
      async () => {
        await updateUserStatus(adminPrincipal, adminUser._id.toString(), false);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as ForbiddenError).message, /cannot modify their own/i);
        return true;
      }
    );
  });
});
