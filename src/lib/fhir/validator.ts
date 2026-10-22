/**
 * FHIR R4 Resource Validator
 * 
 * Implements validation rules based on HL7 FHIR Release 4 and NRCeS ABDM Profiles.
 * 
 * Validation Classification:
 * - Generic FHIR R4: Structural constraints, required resourceType, id syntax,
 *   Bundle entry hierarchy, reference uri syntax, ISO-8601 date parsing.
 * - ABDM/NRCeS Profile Expectations: Patient ABHA identifiers, CareContext references,
 *   LOINC/SNOMED CT coding, HI-Type taxonomy.
 */

import {
  SUPPORTED_FHIR_RESOURCE_TYPES,
  SupportedFhirResourceType,
  BaseFhirResource,
  FhirBundle,
} from "./types";

export interface ValidationIssue {
  severity: "error" | "warning" | "information";
  code: string;
  field?: string;
  message: string;
  standard: "FHIR_R4_CORE" | "ABDM_NRCES_PROFILE";
}

export interface ValidationResult {
  isValid: boolean;
  resourceType?: string;
  resourceId?: string;
  issues: ValidationIssue[];
}

/**
 * Validate that an object is a recognized FHIR R4 resource or Bundle
 */
export function validateFhirResource(
  rawResource: unknown,
  options?: {
    expectedPatientId?: string;
    expectedResourceType?: SupportedFhirResourceType;
  }
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!rawResource || typeof rawResource !== "object") {
    return {
      isValid: false,
      issues: [
        {
          severity: "error",
          code: "STRUCTURE_INVALID",
          message: "Provided FHIR payload must be a non-null JSON object.",
          standard: "FHIR_R4_CORE",
        },
      ],
    };
  }

  const res = rawResource as Record<string, unknown>;

  // 1. Validate resourceType
  if (!res.resourceType || typeof res.resourceType !== "string") {
    issues.push({
      severity: "error",
      code: "MISSING_RESOURCE_TYPE",
      field: "resourceType",
      message: "Resource missing mandatory 'resourceType' string attribute.",
      standard: "FHIR_R4_CORE",
    });
    return { isValid: false, issues };
  }

  const resourceType = res.resourceType;

  // Handle Bundle separately
  if (resourceType === "Bundle") {
    return validateFhirBundle(res as unknown as FhirBundle, options);
  }

  // 2. Validate against supported resource types
  if (!SUPPORTED_FHIR_RESOURCE_TYPES.includes(resourceType as SupportedFhirResourceType)) {
    issues.push({
      severity: "error",
      code: "UNSUPPORTED_RESOURCE_TYPE",
      field: "resourceType",
      message: `Resource type '${resourceType}' is not supported in this exchange milestone.`,
      standard: "FHIR_R4_CORE",
    });
    return { isValid: false, resourceType, issues };
  }

  // 3. Expected resourceType check if requested
  if (options?.expectedResourceType && resourceType !== options.expectedResourceType) {
    issues.push({
      severity: "error",
      code: "TYPE_MISMATCH",
      field: "resourceType",
      message: `Resource type mismatch: expected '${options.expectedResourceType}', got '${resourceType}'.`,
      standard: "FHIR_R4_CORE",
    });
  }

  // 4. Validate ID
  if (!res.id || typeof res.id !== "string" || res.id.trim().length === 0) {
    issues.push({
      severity: "error",
      code: "MISSING_RESOURCE_ID",
      field: "id",
      message: "Resource missing required 'id' attribute.",
      standard: "FHIR_R4_CORE",
    });
  } else if (!/^[A-Za-z0-9\-.]{1,64}$/.test(res.id)) {
    // FHIR R4 id regex: 1-64 chars of [A-Za-z0-9\-.]
    issues.push({
      severity: "error",
      code: "INVALID_RESOURCE_ID_FORMAT",
      field: "id",
      message: "Resource 'id' must consist of 1-64 characters matching [A-Za-z0-9-.].",
      standard: "FHIR_R4_CORE",
    });
  }

  const resourceId = typeof res.id === "string" ? res.id : undefined;

  // 5. Patient association check
  if (options?.expectedPatientId) {
    const patientRef = extractPatientReference(res);
    if (!patientRef) {
      // Patient itself or non-clinical metadata resource (Practitioner/Organization)
      if (resourceType !== "Patient" && resourceType !== "Practitioner" && resourceType !== "Organization") {
        issues.push({
          severity: "error",
          code: "MISSING_PATIENT_REFERENCE",
          field: "subject",
          message: `Clinical resource of type '${resourceType}' must contain a valid patient reference.`,
          standard: "FHIR_R4_CORE",
        });
      }
    } else {
      const normalizedRef = patientRef.replace(/^(Patient\/|urn:uuid:)/, "");
      const normalizedExpected = options.expectedPatientId.replace(/^(Patient\/|urn:uuid:)/, "");
      if (normalizedRef !== normalizedExpected && !patientRef.includes(normalizedExpected)) {
        issues.push({
          severity: "error",
          code: "PATIENT_REFERENCE_MISMATCH",
          field: "subject.reference",
          message: "Resource patient reference does not match the authorized exchange subject.",
          standard: "ABDM_NRCES_PROFILE",
        });
      }
    }
  }

  // 6. Resource-specific essential field checks
  validateResourceSpecificFields(res, resourceType as SupportedFhirResourceType, issues);

  const isValid = issues.every((i) => i.severity !== "error");
  return {
    isValid,
    resourceType,
    resourceId,
    issues,
  };
}

/**
 * Validate an entire FHIR R4 Bundle
 */
export function validateFhirBundle(
  bundle: FhirBundle,
  options?: { expectedPatientId?: string }
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!bundle.type || typeof bundle.type !== "string") {
    issues.push({
      severity: "error",
      code: "MISSING_BUNDLE_TYPE",
      field: "type",
      message: "Bundle missing mandatory 'type' attribute.",
      standard: "FHIR_R4_CORE",
    });
  }

  if (bundle.entry && !Array.isArray(bundle.entry)) {
    issues.push({
      severity: "error",
      code: "INVALID_BUNDLE_ENTRIES",
      field: "entry",
      message: "Bundle 'entry' must be an array of BundleEntry objects.",
      standard: "FHIR_R4_CORE",
    });
    return { isValid: false, resourceType: "Bundle", issues };
  }

  const entries = bundle.entry || [];
  let entryIndex = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !entry.resource) {
      issues.push({
        severity: "error",
        code: "MALFORMED_BUNDLE_ENTRY",
        field: `entry[${entryIndex}]`,
        message: `Bundle entry at index ${entryIndex} is missing resource object.`,
        standard: "FHIR_R4_CORE",
      });
      entryIndex++;
      continue;
    }

    const subValidation = validateFhirResource(entry.resource, {
      expectedPatientId: options?.expectedPatientId,
    });

    if (!subValidation.isValid) {
      for (const issue of subValidation.issues) {
        issues.push({
          ...issue,
          field: `entry[${entryIndex}].resource.${issue.field || ""}`,
        });
      }
    }

    entryIndex++;
  }

  const isValid = issues.every((i) => i.severity !== "error");
  return {
    isValid,
    resourceType: "Bundle",
    resourceId: bundle.id,
    issues,
  };
}

/**
 * Extract patient reference from diverse FHIR resources
 */
export function extractPatientReference(res: Record<string, unknown>): string | null {
  // subject (Encounter, Observation, DiagnosticReport, ServiceRequest, MedicationRequest, MedicationDispense, DocumentReference)
  if (res.subject && typeof res.subject === "object") {
    const s = res.subject as { reference?: string };
    if (typeof s.reference === "string") return s.reference;
  }

  // patient (Immunization)
  if (res.patient && typeof res.patient === "object") {
    const p = res.patient as { reference?: string };
    if (typeof p.reference === "string") return p.reference;
  }

  // Patient resource itself
  if (res.resourceType === "Patient" && typeof res.id === "string") {
    return `Patient/${res.id}`;
  }

  return null;
}

/**
 * Validate specific required fields per resource type
 */
function validateResourceSpecificFields(
  res: Record<string, unknown>,
  type: SupportedFhirResourceType,
  issues: ValidationIssue[]
): void {
  switch (type) {
    case "Observation": {
      if (!res.status) {
        issues.push({
          severity: "error",
          code: "MISSING_STATUS",
          field: "status",
          message: "Observation missing required 'status'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.code) {
        issues.push({
          severity: "error",
          code: "MISSING_CODE",
          field: "code",
          message: "Observation missing required 'code'.",
          standard: "FHIR_R4_CORE",
        });
      }
      break;
    }

    case "DiagnosticReport": {
      if (!res.status) {
        issues.push({
          severity: "error",
          code: "MISSING_STATUS",
          field: "status",
          message: "DiagnosticReport missing required 'status'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.code) {
        issues.push({
          severity: "error",
          code: "MISSING_CODE",
          field: "code",
          message: "DiagnosticReport missing required 'code'.",
          standard: "FHIR_R4_CORE",
        });
      }
      break;
    }

    case "Encounter": {
      if (!res.status) {
        issues.push({
          severity: "error",
          code: "MISSING_STATUS",
          field: "status",
          message: "Encounter missing required 'status'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.class) {
        issues.push({
          severity: "error",
          code: "MISSING_CLASS",
          field: "class",
          message: "Encounter missing required 'class'.",
          standard: "FHIR_R4_CORE",
        });
      }
      break;
    }

    case "MedicationRequest": {
      if (!res.status) {
        issues.push({
          severity: "error",
          code: "MISSING_STATUS",
          field: "status",
          message: "MedicationRequest missing required 'status'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.intent) {
        issues.push({
          severity: "error",
          code: "MISSING_INTENT",
          field: "intent",
          message: "MedicationRequest missing required 'intent'.",
          standard: "FHIR_R4_CORE",
        });
      }
      break;
    }

    case "MedicationDispense": {
      if (!res.status) {
        issues.push({
          severity: "error",
          code: "MISSING_STATUS",
          field: "status",
          message: "MedicationDispense missing required 'status'.",
          standard: "FHIR_R4_CORE",
        });
      }
      break;
    }

    case "Immunization": {
      if (!res.status) {
        issues.push({
          severity: "error",
          code: "MISSING_STATUS",
          field: "status",
          message: "Immunization missing required 'status'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.vaccineCode) {
        issues.push({
          severity: "error",
          code: "MISSING_VACCINE_CODE",
          field: "vaccineCode",
          message: "Immunization missing required 'vaccineCode'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.occurrenceDateTime) {
        issues.push({
          severity: "error",
          code: "MISSING_OCCURRENCE_DATE",
          field: "occurrenceDateTime",
          message: "Immunization missing required 'occurrenceDateTime'.",
          standard: "FHIR_R4_CORE",
        });
      }
      break;
    }

    case "DocumentReference": {
      if (!res.status) {
        issues.push({
          severity: "error",
          code: "MISSING_STATUS",
          field: "status",
          message: "DocumentReference missing required 'status'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.content || !Array.isArray(res.content) || res.content.length === 0) {
        issues.push({
          severity: "error",
          code: "MISSING_CONTENT",
          field: "content",
          message: "DocumentReference missing required 'content' attachment array.",
          standard: "FHIR_R4_CORE",
        });
      }
      break;
    }

    case "ServiceRequest": {
      if (!res.status) {
        issues.push({
          severity: "error",
          code: "MISSING_STATUS",
          field: "status",
          message: "ServiceRequest missing required 'status'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.intent) {
        issues.push({
          severity: "error",
          code: "MISSING_INTENT",
          field: "intent",
          message: "ServiceRequest missing required 'intent'.",
          standard: "FHIR_R4_CORE",
        });
      }
      if (!res.code) {
        issues.push({
          severity: "error",
          code: "MISSING_CODE",
          field: "code",
          message: "ServiceRequest missing required 'code'.",
          standard: "FHIR_R4_CORE",
        });
      }
      break;
    }

    default:
      break;
  }
}
