/**
 * ABDM Mock Adapter Types & Institution Definitions
 * 
 * Simulated Ayushman Bharat Digital Mission (ABDM) interfaces
 * for National Health Stack interoperability.
 */

export interface ParticipatingInstitution {
  id: string;
  name: string;
  type: "hospital" | "clinic" | "laboratory" | "speciality";
  city: string;
  state: string;
  endpointUrl: string;
  isMockHip: true;
}

export const PARTICIPATING_INSTITUTIONS: ParticipatingInstitution[] = [
  {
    id: "HIP-MAX-001",
    name: "Max Super Speciality Hospital, Saket",
    type: "hospital",
    city: "New Delhi",
    state: "Delhi",
    endpointUrl: "https://mock.abdm.gateway/hip/max-saket/v1",
    isMockHip: true,
  },
  {
    id: "HIP-APOLLO-002",
    name: "Apollo Clinics, Indiranagar",
    type: "clinic",
    city: "Bengaluru",
    state: "Karnataka",
    endpointUrl: "https://mock.abdm.gateway/hip/apollo-indiranagar/v1",
    isMockHip: true,
  },
  {
    id: "HIP-LAL-003",
    name: "Dr. Lal PathLabs Central Reference Lab",
    type: "laboratory",
    city: "Rohini, New Delhi",
    state: "Delhi",
    endpointUrl: "https://mock.abdm.gateway/hip/dr-lal-pathlabs/v1",
    isMockHip: true,
  },
  {
    id: "HIP-FORTIS-004",
    name: "Fortis Hospital, Bannerghatta Road",
    type: "speciality",
    city: "Bengaluru",
    state: "Karnataka",
    endpointUrl: "https://mock.abdm.gateway/hip/fortis-bannerghatta/v1",
    isMockHip: true,
  },
];

export interface DiscoveredCareContext {
  careContextId: string;
  patientAbhaAddress: string;
  institutionId: string;
  institutionName: string;
  institutionType: string;
  description: string;
  resourceCount: number;
  availableHiTypes: string[];
  earliestDate: string;
  latestDate: string;
  isMockData: true;
}

export interface HealthDataTransferInitParams {
  transactionId?: string;
  consentId: string;
  patientId: string;
  patientAbhaAddress: string;
  requesterDoctorId: string;
  requesterFacility: string;
  hipId: string;
  requestedHiTypes?: string[];
  dateRangeFrom?: Date | string;
  dateRangeTo?: Date | string;
}

export interface HealthDataTransferStatusReport {
  transferId: string;
  transactionId: string;
  consentId: string;
  status: "REQUESTED" | "PROCESSING" | "TRANSFERRED" | "FAILED";
  hipId: string;
  hipName: string;
  requestedHiTypes: string[];
  recordCount: number;
  bundleId?: string;
  retryCount: number;
  lastAttemptAt: string;
  completedAt?: string;
  failureReason?: string;
  expiresAt: string;
  isMockInteraction: true;
}
