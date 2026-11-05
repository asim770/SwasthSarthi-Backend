import { MockAbhaIdentityProvider, MockAbhaIdentity } from "../types";
import { User } from "@/lib/db/models/User";
import { seedDemoIdentities, DEMO_IDENTITIES } from "@/lib/db/seed";
import { connectToDatabase } from "@/lib/db/connect";

/**
 * MockAbhaIdentityProvider
 * 
 * Simulates the National Health Authority / ABDM ABHA Identity Provider
 * for this college demonstration project.
 * 
 * This identity resolution is strictly simulated:
 * - Does not contact real ABDM gateway or NDHM sandbox.
 * - Resolves synthetic demo identities from MongoDB / seed data.
 * - Always marks identity records with isMock: true.
 */
export class DefaultMockAbhaIdentityProvider implements MockAbhaIdentityProvider {
  public async resolveIdentity(identifier: string): Promise<MockAbhaIdentity | null> {
    if (!identifier || typeof identifier !== "string") {
      return null;
    }

    const trimmed = identifier.trim();
    const normalized = trimmed.toLowerCase();

    await connectToDatabase();
    await seedDemoIdentities();

    // Look up in database
    const user = await User.findOne({
      $or: [
        { abhaId: trimmed },
        { abhaAddress: normalized },
      ],
    });

    if (user) {
      return {
        abhaId: user.abhaId,
        abhaAddress: user.abhaAddress,
        name: user.name,
        role: user.role,
        phone: user.phone,
        email: user.email,
        gender: user.gender,
        dateOfBirth: user.dateOfBirth,
        facility: user.facility,
        specialization: user.specialization,
        isActive: user.isActive,
        isMock: true,
      };
    }

    // Fallback: check DEMO_IDENTITIES list directly
    const fallback = DEMO_IDENTITIES.find(
      (d) =>
        d.abhaId === trimmed ||
        d.abhaAddress.toLowerCase() === normalized
    );

    if (fallback) {
      return {
        abhaId: fallback.abhaId,
        abhaAddress: fallback.abhaAddress,
        name: fallback.name,
        role: fallback.role,
        phone: fallback.phone,
        email: fallback.email,
        gender: fallback.gender,
        dateOfBirth: fallback.dateOfBirth,
        facility: fallback.facility,
        specialization: fallback.specialization,
        isActive: fallback.isActive,
        isMock: true,
      };
    }

    return null;
  }
}
