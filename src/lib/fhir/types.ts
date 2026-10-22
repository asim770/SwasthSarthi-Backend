/**
 * SwasthSaarthi FHIR R4 Resource Types
 * Official HL7 FHIR Release 4 specification references
 * Combined with NRCeS (National Resource Centre for EHR in India) ABDM profiles
 */

export const SUPPORTED_FHIR_RESOURCE_TYPES = [
  "Patient",
  "Practitioner",
  "Organization",
  "Encounter",
  "Observation",
  "DiagnosticReport",
  "ServiceRequest",
  "MedicationRequest",
  "MedicationDispense",
  "Immunization",
  "DocumentReference",
] as const;

export type SupportedFhirResourceType = (typeof SUPPORTED_FHIR_RESOURCE_TYPES)[number];

export interface FhirCoding {
  system?: string;
  version?: string;
  code?: string;
  display?: string;
  userSelected?: boolean;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirIdentifier {
  use?: "usual" | "official" | "temp" | "secondary" | "old";
  type?: FhirCodeableConcept;
  system?: string;
  value?: string;
}

export interface FhirReference {
  reference?: string;
  type?: string;
  identifier?: FhirIdentifier;
  display?: string;
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirQuantity {
  value?: number;
  comparator?: "<" | "<=" | ">=" | ">";
  unit?: string;
  system?: string;
  code?: string;
}

export interface FhirAttachment {
  contentType?: string;
  language?: string;
  data?: string;
  url?: string;
  size?: number;
  hash?: string;
  title?: string;
  creation?: string;
}

export interface BaseFhirResource {
  resourceType: SupportedFhirResourceType | "Bundle";
  id: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
    profile?: string[];
    source?: string;
  };
  implicitRules?: string;
  language?: string;
  [key: string]: unknown;
}

export interface FhirPatient extends BaseFhirResource {
  resourceType: "Patient";
  identifier?: FhirIdentifier[];
  active?: boolean;
  name?: Array<{
    use?: string;
    text?: string;
    family?: string;
    given?: string[];
  }>;
  telecom?: Array<{
    system?: string;
    value?: string;
    use?: string;
  }>;
  gender?: "male" | "female" | "other" | "unknown";
  birthDate?: string;
}

export interface FhirPractitioner extends BaseFhirResource {
  resourceType: "Practitioner";
  identifier?: FhirIdentifier[];
  active?: boolean;
  name?: Array<{
    text?: string;
    family?: string;
    given?: string[];
    prefix?: string[];
  }>;
  qualification?: Array<{
    code?: FhirCodeableConcept;
  }>;
}

export interface FhirOrganization extends BaseFhirResource {
  resourceType: "Organization";
  identifier?: FhirIdentifier[];
  active?: boolean;
  name?: string;
  type?: FhirCodeableConcept[];
}

export interface FhirEncounter extends BaseFhirResource {
  resourceType: "Encounter";
  status: "planned" | "arrived" | "triaged" | "in-progress" | "onleave" | "finished" | "cancelled";
  class: FhirCoding;
  subject: FhirReference;
  participant?: Array<{
    individual?: FhirReference;
  }>;
  period?: FhirPeriod;
  reasonCode?: FhirCodeableConcept[];
  serviceProvider?: FhirReference;
}

export interface FhirObservation extends BaseFhirResource {
  resourceType: "Observation";
  status: "registered" | "preliminary" | "final" | "amended" | "corrected" | "cancelled" | "entered-in-error" | "unknown";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  performer?: FhirReference[];
  valueQuantity?: FhirQuantity;
  valueString?: string;
  valueCodeableConcept?: FhirCodeableConcept;
  interpretation?: FhirCodeableConcept[];
  referenceRange?: Array<{
    low?: FhirQuantity;
    high?: FhirQuantity;
    text?: string;
  }>;
}

export interface FhirDiagnosticReport extends BaseFhirResource {
  resourceType: "DiagnosticReport";
  status: "registered" | "partial" | "preliminary" | "final" | "amended" | "corrected" | "appended" | "cancelled" | "entered-in-error" | "unknown";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  performer?: FhirReference[];
  result?: FhirReference[];
  conclusion?: string;
  conclusionCode?: FhirCodeableConcept[];
  presentedForm?: FhirAttachment[];
}

export interface FhirServiceRequest extends BaseFhirResource {
  resourceType: "ServiceRequest";
  status: "draft" | "active" | "on-hold" | "revoked" | "completed" | "entered-in-error" | "unknown";
  intent: "proposal" | "plan" | "directive" | "order" | "original-order" | "reflex-order" | "filler-order" | "instance-order" | "option";
  code?: FhirCodeableConcept;
  subject: FhirReference;
  authoredOn?: string;
  requester?: FhirReference;
  priority?: "routine" | "urgent" | "asap" | "stat";
}

export interface FhirMedicationRequest extends BaseFhirResource {
  resourceType: "MedicationRequest";
  status: "active" | "on-hold" | "cancelled" | "completed" | "entered-in-error" | "stopped" | "draft" | "unknown";
  intent: "proposal" | "plan" | "order" | "original-order" | "reflex-order" | "filler-order" | "instance-order" | "option";
  medicationCodeableConcept?: FhirCodeableConcept;
  medicationReference?: FhirReference;
  subject: FhirReference;
  authoredOn?: string;
  requester?: FhirReference;
  dosageInstruction?: Array<{
    text?: string;
    timing?: {
      repeat?: {
        frequency?: number;
        period?: number;
        periodUnit?: string;
      };
    };
    route?: FhirCodeableConcept;
  }>;
  dispenseRequest?: {
    numberOfRepeatsAllowed?: number;
    quantity?: FhirQuantity;
  };
}

export interface FhirMedicationDispense extends BaseFhirResource {
  resourceType: "MedicationDispense";
  status: "preparation" | "in-progress" | "cancelled" | "on-hold" | "completed" | "entered-in-error" | "stopped" | "unknown";
  medicationCodeableConcept?: FhirCodeableConcept;
  medicationReference?: FhirReference;
  subject: FhirReference;
  authorizingPrescription?: FhirReference[];
  quantity?: FhirQuantity;
  whenHandedOver?: string;
  whenPrepared?: string;
  performer?: Array<{
    actor?: FhirReference;
  }>;
}

export interface FhirImmunization extends BaseFhirResource {
  resourceType: "Immunization";
  status: "completed" | "entered-in-error" | "not-done";
  vaccineCode: FhirCodeableConcept;
  patient: FhirReference;
  occurrenceDateTime: string;
  primarySource?: boolean;
  lotNumber?: string;
  expirationDate?: string;
  site?: FhirCodeableConcept;
  route?: FhirCodeableConcept;
  doseQuantity?: FhirQuantity;
  performer?: Array<{
    actor?: FhirReference;
  }>;
}

export interface FhirDocumentReference extends BaseFhirResource {
  resourceType: "DocumentReference";
  status: "current" | "superseded" | "entered-in-error";
  docStatus?: "preliminary" | "final" | "amended" | "entered-in-error";
  type?: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  subject?: FhirReference;
  date?: string;
  author?: FhirReference[];
  description?: string;
  content: Array<{
    attachment: FhirAttachment;
  }>;
  context?: {
    encounter?: FhirReference[];
    period?: FhirPeriod;
  };
}

export interface FhirBundleEntry {
  fullUrl?: string;
  resource: BaseFhirResource;
  search?: {
    mode?: "match" | "include" | "outcome";
  };
}

export interface FhirBundle extends BaseFhirResource {
  resourceType: "Bundle";
  type: "document" | "message" | "transaction" | "transaction-response" | "batch" | "batch-response" | "history" | "searchset" | "collection";
  timestamp?: string;
  total?: number;
  entry?: FhirBundleEntry[];
}
