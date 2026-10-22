import {
  ParticipatingInstitution,
  DiscoveredCareContext,
  HealthDataTransferInitParams,
  HealthDataTransferStatusReport,
} from "./types";
import { AuthenticatedPrincipal } from "@/lib/dal/types";
import { FhirBundle } from "@/lib/fhir/types";

export interface IAbdmAdapter {
  getParticipatingInstitutions(): Promise<ParticipatingInstitution[]>;

  discoverPatientCareContexts(
    patientAbhaAddress: string
  ): Promise<DiscoveredCareContext[]>;

  initiateHealthDataTransfer(
    params: HealthDataTransferInitParams,
    principal: AuthenticatedPrincipal
  ): Promise<HealthDataTransferStatusReport>;

  executeTransfer(
    transferId: string,
    principal?: AuthenticatedPrincipal
  ): Promise<{
    transfer: HealthDataTransferStatusReport;
    bundle?: FhirBundle;
  }>;

  getTransferStatus(
    transferId: string,
    principal: AuthenticatedPrincipal
  ): Promise<HealthDataTransferStatusReport>;
}
