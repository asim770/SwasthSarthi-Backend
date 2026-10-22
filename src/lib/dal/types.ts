import { UserRole } from "@/lib/db/models/User";

export interface AuthenticatedPrincipal {
  id: string;
  abhaId: string;
  abhaAddress: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  facility?: string;
  specialization?: string;
  sessionId: string;
}

export interface ConsentEvaluationResult {
  hasConsent: boolean;
  reason?: string;
  consentId?: string;
  allowedHiTypes?: string[];
  dateRangeFrom?: Date;
  dateRangeTo?: Date;
}
