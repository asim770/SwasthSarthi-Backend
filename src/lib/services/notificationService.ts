import mongoose from "mongoose";
import { User } from "@/lib/db/models/User";
import { INotification, NotificationCategory } from "@/lib/db/models/Notification";
import { createNotification, CreateNotificationParams } from "@/lib/dal/notifications";
import { dispatchNotification } from "@/lib/queue/notificationWorker";
import { connectToDatabase } from "@/lib/db/connect";

export type HealthcareEventType =
  | "DOCTOR_REGISTERED"
  | "LABORATORY_REGISTERED"
  | "PHARMACY_REGISTERED"
  | "PRACTITIONER_REVIEWED"
  | "CONSULTATION_CREATED"
  | "LAB_REPORT_UPLOADED"
  | "PRESCRIPTION_CREATED"
  | "PRESCRIPTION_DISPENSED"
  | "CONSENT_REQUESTED"
  | "CONSENT_RESPONDED";

export interface HealthcareNotificationEvent {
  type: HealthcareEventType;
  actorId?: string | mongoose.Types.ObjectId;
  actorName?: string;
  targetUserId?: string | mongoose.Types.ObjectId;
  targetPatientId?: string | mongoose.Types.ObjectId;
  resourceId?: string;
  resourceType?: string;
  facility?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Determine authorized recipients and dispatch scoped notifications
 * Resolves verified database recipients to prevent cross-role broadcast leakage
 */
export async function sendHealthcareEventNotification(
  event: HealthcareNotificationEvent
): Promise<{ dispatchedCount: number; notifications: INotification[] }> {
  await connectToDatabase();
  const createdNotifications: INotification[] = [];

  switch (event.type) {
    case "DOCTOR_REGISTERED": {
      // Intended recipient: Authorized Administrators ONLY
      const admins = await User.find({ role: "admin", isActive: true });
      for (const admin of admins) {
        const docId = event.targetUserId?.toString() || "unknown";
        const res = await dispatchNotification({
          recipientId: admin._id,
          recipientRole: "admin",
          recipientAbha: admin.abhaAddress || admin.email || "",
          category: "ONBOARDING",
          title: "New Doctor Registration",
          message: `A new doctor registration for Dr. ${event.actorName || "Medical Practitioner"} requires administrator review.`,
          relatedResourceId: docId,
          relatedResourceType: "User",
          idempotencyKey: `notif-doc-reg-${docId}-${admin._id}`,
          metadata: { doctorId: docId, ...event.metadata },
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "LABORATORY_REGISTERED": {
      // Intended recipient: Authorized Administrators ONLY
      const admins = await User.find({ role: "admin", isActive: true });
      for (const admin of admins) {
        const labId = event.targetUserId?.toString() || "unknown";
        const facilityName = event.facility || event.actorName || "Laboratory Facility";
        const res = await dispatchNotification({
          recipientId: admin._id,
          recipientRole: "admin",
          recipientAbha: admin.abhaAddress || admin.email || "",
          category: "ONBOARDING",
          title: "New Laboratory Registration",
          message: `A new laboratory facility '${facilityName}' has registered and requires administrator review.`,
          relatedResourceId: labId,
          relatedResourceType: "User",
          idempotencyKey: `notif-lab-reg-${labId}-${admin._id}`,
          metadata: { facilityName, ...event.metadata },
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "PHARMACY_REGISTERED": {
      // Intended recipient: Authorized Administrators ONLY
      const admins = await User.find({ role: "admin", isActive: true });
      for (const admin of admins) {
        const pharmId = event.targetUserId?.toString() || "unknown";
        const facilityName = event.facility || event.actorName || "Pharmacy Facility";
        const res = await dispatchNotification({
          recipientId: admin._id,
          recipientRole: "admin",
          recipientAbha: admin.abhaAddress || admin.email || "",
          category: "ONBOARDING",
          title: "New Pharmacy Registration",
          message: `A new pharmacy facility '${facilityName}' has registered and requires administrator review.`,
          relatedResourceId: pharmId,
          relatedResourceType: "User",
          idempotencyKey: `notif-pharm-reg-${pharmId}-${admin._id}`,
          metadata: { facilityName, ...event.metadata },
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "PRACTITIONER_REVIEWED": {
      // Intended recipient: That specific practitioner (Doctor, Lab, or Pharmacy)
      if (!event.targetUserId) break;
      const targetUser = await User.findById(event.targetUserId);
      if (targetUser) {
        const statusLabel = event.status || targetUser.verificationStatus;
        const res = await dispatchNotification({
          recipientId: targetUser._id,
          recipientRole: targetUser.role,
          recipientAbha: targetUser.abhaAddress || targetUser.email || "",
          category: "SECURITY",
          title: `Account ${statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1).toLowerCase()}`,
          message: `Your ${targetUser.role} account verification status has been updated to ${statusLabel}.`,
          relatedResourceId: targetUser._id.toString(),
          relatedResourceType: "User",
          idempotencyKey: `notif-pract-rev-${targetUser._id}-${statusLabel}`,
          metadata: { newStatus: statusLabel, ...event.metadata },
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "CONSULTATION_CREATED": {
      // Intended recipient: Relevant patient only
      if (!event.targetPatientId) break;
      const patient = await User.findById(event.targetPatientId);
      if (patient) {
        const doctorName = event.actorName ? `Dr. ${event.actorName}` : "Your doctor";
        const res = await dispatchNotification({
          recipientId: patient._id,
          recipientRole: "patient",
          recipientAbha: patient.abhaAddress || patient.patientId || "",
          category: "CONSULTATION",
          title: "New Consultation Report",
          message: `${doctorName} has added a new consultation report to your health records.`,
          relatedResourceId: event.resourceId,
          relatedResourceType: "Encounter",
          idempotencyKey: `notif-consultation-${event.resourceId || Date.now()}`,
          metadata: event.metadata,
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "LAB_REPORT_UPLOADED": {
      // Intended recipient: Relevant patient only
      if (!event.targetPatientId) break;
      const patient = await User.findById(event.targetPatientId);
      if (patient) {
        const facilityName = event.facility || "Diagnostic Laboratory";
        const res = await dispatchNotification({
          recipientId: patient._id,
          recipientRole: "patient",
          recipientAbha: patient.abhaAddress || patient.patientId || "",
          category: "LAB_REPORT",
          title: "Diagnostic Report Ready",
          message: `A new laboratory diagnostic report has been finalized and uploaded by ${facilityName}.`,
          relatedResourceId: event.resourceId,
          relatedResourceType: "DiagnosticReport",
          idempotencyKey: `notif-lab-${event.resourceId || Date.now()}`,
          metadata: event.metadata,
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "PRESCRIPTION_CREATED": {
      // Intended recipient: Relevant patient
      if (!event.targetPatientId) break;
      const patient = await User.findById(event.targetPatientId);
      if (patient) {
        const doctorName = event.actorName ? `Dr. ${event.actorName}` : "Your doctor";
        const res = await dispatchNotification({
          recipientId: patient._id,
          recipientRole: "patient",
          recipientAbha: patient.abhaAddress || patient.patientId || "",
          category: "PRESCRIPTION",
          title: "New Prescription Issued",
          message: `A new prescription has been issued by ${doctorName}.`,
          relatedResourceId: event.resourceId,
          relatedResourceType: "MedicationRequest",
          idempotencyKey: `notif-presc-${event.resourceId || Date.now()}`,
          metadata: event.metadata,
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "PRESCRIPTION_DISPENSED": {
      // Intended recipient: Relevant patient
      if (!event.targetPatientId) break;
      const patient = await User.findById(event.targetPatientId);
      if (patient) {
        const pharmacyName = event.facility || "Pharmacy";
        const res = await dispatchNotification({
          recipientId: patient._id,
          recipientRole: "patient",
          recipientAbha: patient.abhaAddress || patient.patientId || "",
          category: "DISPENSE",
          title: "Medicine Dispensed",
          message: `Your prescription has been dispensed by ${pharmacyName}.`,
          relatedResourceId: event.resourceId,
          relatedResourceType: "MedicationDispense",
          idempotencyKey: `notif-dispense-${event.resourceId || Date.now()}`,
          metadata: event.metadata,
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "CONSENT_REQUESTED": {
      // Intended recipient: Relevant patient
      if (!event.targetPatientId) break;
      const patient = await User.findById(event.targetPatientId);
      if (patient) {
        const doctorName = event.actorName ? `Dr. ${event.actorName}` : "A doctor";
        const res = await dispatchNotification({
          recipientId: patient._id,
          recipientRole: "patient",
          recipientAbha: patient.abhaAddress || patient.patientId || "",
          category: "CONSENT",
          title: "New Health Data Consent Request",
          message: `${doctorName} has requested access to your health records.`,
          relatedResourceId: event.resourceId,
          relatedResourceType: "ConsentArtifact",
          idempotencyKey: `notif-consent-req-${event.resourceId || Date.now()}`,
          metadata: event.metadata,
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    case "CONSENT_RESPONDED": {
      // Intended recipient: Requesting doctor
      if (!event.targetUserId) break;
      const doctor = await User.findById(event.targetUserId);
      if (doctor) {
        const decision = event.status === "APPROVED" ? "Approved" : "Denied";
        const patientName = event.actorName || "Patient";
        const res = await dispatchNotification({
          recipientId: doctor._id,
          recipientRole: "doctor",
          recipientAbha: doctor.abhaAddress || doctor.email || "",
          category: "CONSENT",
          title: `Consent Request ${decision}`,
          message: `${patientName} has ${decision.toLowerCase()} your health record access request.`,
          relatedResourceId: event.resourceId,
          relatedResourceType: "ConsentArtifact",
          idempotencyKey: `notif-consent-dec-${event.resourceId}-${decision}`,
          metadata: event.metadata,
        });
        createdNotifications.push(res.notification);
      }
      break;
    }

    default:
      break;
  }

  return {
    dispatchedCount: createdNotifications.length,
    notifications: createdNotifications,
  };
}
