import { connectToDatabase } from "../lib/db/connect";
import { User } from "../lib/db/models/User";
import { Facility } from "../lib/db/models/Facility";
import { Session } from "../lib/db/models/Session";
import { Notification } from "../lib/db/models/Notification";
import { LabOrder } from "../lib/db/models/LabOrder";
import { Prescription } from "../lib/db/models/Prescription";
import { ConsentArtifact } from "../lib/db/models/ConsentArtifact";
import { HealthRecord } from "../lib/db/models/HealthRecord";
import { SourceInstitutionRecord } from "../lib/db/models/SourceInstitutionRecord";

/**
 * Remove all synthetic dummy test data from the database,
 * preserving only legitimate user accounts and canonical baseline demo identities.
 */
export async function cleanDummyData() {
  await connectToDatabase();

  const allowedEmails = [
    "admin.neha@synthetic.demo",
    "rahul.verma@synthetic.demo",
    "dr.ananya@synthetic.demo",
    "max.lab@synthetic.demo",
    "apollo.rx@synthetic.demo",
    "inactive@synthetic.demo",
    "asimmaji.123456789@gmail.com",
    "majiasim.1234@gmail.com",
    "pandi.1tsumit@gmail.com",
  ].map((e) => e.toLowerCase());

  const allowedAbhas = [
    "admin.neha@swasth.sbx",
    "rahul.verma@sbx",
    "dr.ananya@hpr.sbx",
    "max.lab@hfr.sbx",
    "apollo.rx@hfr.sbx",
    "inactive.user@sbx",
    "asimmaji1234567892421@sbx",
    "majiasim12349743@sbx",
    "pandi1tsumit8927@sbx",
  ].map((a) => a.toLowerCase());

  const keptUsers = await User.find({
    $or: [
      { email: { $in: allowedEmails } },
      { abhaAddress: { $in: allowedAbhas } },
    ],
  });

  const keepIds = keptUsers.map((u) => u._id);

  // 1. Delete all dummy facilities
  const delFacilities = await Facility.deleteMany({});

  // 2. Delete all dummy users
  const delUsers = await User.deleteMany({ _id: { $nin: keepIds } });

  // 3. Delete orphan sessions
  const delSessions = await Session.deleteMany({ userId: { $nin: keepIds } });

  // 4. Delete all dummy notifications
  const delNotifications = await Notification.deleteMany({});

  // 5. Delete orphan lab orders
  const delLabOrders = await LabOrder.deleteMany({
    $or: [
      { patientId: { $nin: keepIds } },
      { doctorId: { $nin: keepIds } },
    ],
  });

  // 6. Delete orphan prescriptions
  const delPrescriptions = await Prescription.deleteMany({
    $or: [
      { patientId: { $nin: keepIds } },
      { doctorId: { $nin: keepIds } },
    ],
  });

  // 7. Delete orphan consent artifacts
  const delConsents = await ConsentArtifact.deleteMany({
    patientId: { $nin: keepIds },
  });

  // 8. Delete orphan health records
  const delRecords = await HealthRecord.deleteMany({
    patientId: { $nin: keepIds },
  });

  // 9. Keep only canonical clinical source records
  const canonicalSourceIds = [
    "SRC-MAX-001",
    "SRC-MAX-002",
    "SRC-MAX-003",
    "SRC-APO-001",
    "SRC-APO-002",
    "SRC-APO-003",
    "SRC-LAL-001",
    "SRC-LAL-002",
    "SRC-FOR-001",
    "SRC-FOR-002",
  ];
  const delSourceRecords = await SourceInstitutionRecord.deleteMany({
    recordId: { $nin: canonicalSourceIds },
  });

  console.log("✅ Cleanup finished:", {
    deletedFacilities: delFacilities.deletedCount,
    deletedUsers: delUsers.deletedCount,
    deletedSessions: delSessions.deletedCount,
    deletedNotifications: delNotifications.deletedCount,
    deletedLabOrders: delLabOrders.deletedCount,
    deletedPrescriptions: delPrescriptions.deletedCount,
    deletedConsents: delConsents.deletedCount,
    deletedRecords: delRecords.deletedCount,
    deletedSourceRecords: delSourceRecords.deletedCount,
    remainingUsers: keptUsers.length,
    remainingFacilities: await Facility.countDocuments(),
  });
}

if (typeof process !== "undefined" && process.argv[1]?.includes("cleanDummyData")) {
  cleanDummyData()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Cleanup error:", err);
      process.exit(1);
    });
}
