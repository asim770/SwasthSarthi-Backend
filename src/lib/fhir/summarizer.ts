/**
 * FHIR R4 Clinical Summarizer & Date Normalizer
 * 
 * Safely extracts human-readable summaries and ISO normalized dates from
 * heterogeneous FHIR R4 resources.
 * 
 * Security Guardrail:
 * String values are sanitized to prevent executable HTML/script injection (XSS).
 */

import { SupportedFhirResourceType } from "./types";

/**
 * Escapes characters that could be interpreted as executable HTML tags or scripts
 */
export function sanitizeClinicalString(str: unknown): string {
  if (typeof str !== "string") {
    if (str === null || str === undefined) return "";
    return String(str);
  }
  return str
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .trim();
}

/**
 * Extract normalized Date object from varied FHIR resource date structures
 */
export function extractResourceDate(res: Record<string, unknown>): Date {
  const type = res.resourceType as string;

  let rawDate: string | undefined;

  switch (type) {
    case "Observation":
      rawDate = (res.effectiveDateTime as string) || (res.issued as string);
      break;

    case "DiagnosticReport":
      rawDate = (res.effectiveDateTime as string) || (res.issued as string);
      break;

    case "Encounter":
      if (res.period && typeof res.period === "object") {
        const period = res.period as { start?: string; end?: string };
        rawDate = period.start || period.end;
      }
      break;

    case "MedicationRequest":
      rawDate = res.authoredOn as string;
      break;

    case "MedicationDispense":
      rawDate = (res.whenHandedOver as string) || (res.whenPrepared as string);
      break;

    case "Immunization":
      rawDate = res.occurrenceDateTime as string;
      break;

    case "ServiceRequest":
      rawDate = (res.authoredOn as string) || (res.occurrenceDateTime as string);
      break;

    case "DocumentReference":
      rawDate = res.date as string;
      break;

    default:
      if (typeof res.date === "string") rawDate = res.date;
      break;
  }

  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  // Fallback to meta.lastUpdated or current date
  if (res.meta && typeof res.meta === "object") {
    const meta = res.meta as { lastUpdated?: string };
    if (meta.lastUpdated) {
      const parsed = new Date(meta.lastUpdated);
      if (!isNaN(parsed.getTime())) return parsed;
    }
  }

  return new Date();
}

export interface ClinicalSummary {
  title: string;
  category: string;
  summary: string;
  date: string;
  status: string;
  performer?: string;
  facility?: string;
  details: Record<string, string | number | boolean | null>;
}

/**
 * Extract safe display summary from any supported FHIR R4 resource
 */
export function summarizeFhirResource(res: Record<string, unknown>): ClinicalSummary {
  const type = (res.resourceType as SupportedFhirResourceType) || "Observation";
  const dateObj = extractResourceDate(res);
  const formattedDate = dateObj.toISOString().split("T")[0];
  const status = sanitizeClinicalString(res.status || "final");

  let title = `${type} #${sanitizeClinicalString(res.id || "Unknown")}`;
  let category: string = type;
  let summary = "Clinical record exchanged via ABDM Gateway.";
  const details: Record<string, string | number | boolean | null> = {};
  let performer: string | undefined;

  switch (type) {
    case "DiagnosticReport": {
      const codeObj = res.code as { text?: string; coding?: Array<{ display?: string; code?: string }> } | undefined;
      title = sanitizeClinicalString(codeObj?.text || codeObj?.coding?.[0]?.display || "Diagnostic Lab Report");
      category = "Laboratory / Diagnostics";

      if (typeof res.conclusion === "string" && res.conclusion.trim().length > 0) {
        summary = sanitizeClinicalString(res.conclusion);
      } else {
        summary = "Diagnostic panel results finalized and verified by laboratory.";
      }

      if (Array.isArray(res.performer) && res.performer.length > 0) {
        const perf = res.performer[0] as { display?: string; reference?: string };
        performer = sanitizeClinicalString(perf.display || perf.reference || "");
      }
      break;
    }

    case "Observation": {
      const codeObj = res.code as { text?: string; coding?: Array<{ display?: string; code?: string }> } | undefined;
      title = sanitizeClinicalString(codeObj?.text || codeObj?.coding?.[0]?.display || "Clinical Observation");
      category = "Vitals & Measurements";

      // Extract value
      let valueStr = "";
      if (res.valueQuantity && typeof res.valueQuantity === "object") {
        const vq = res.valueQuantity as { value?: number; unit?: string };
        valueStr = `${vq.value ?? ""} ${vq.unit ?? ""}`.trim();
        details["Value"] = vq.value ?? null;
        details["Unit"] = vq.unit ?? null;
      } else if (typeof res.valueString === "string") {
        valueStr = sanitizeClinicalString(res.valueString);
      } else if (res.valueCodeableConcept && typeof res.valueCodeableConcept === "object") {
        const vcc = res.valueCodeableConcept as { text?: string; coding?: Array<{ display?: string }> };
        valueStr = sanitizeClinicalString(vcc.text || vcc.coding?.[0]?.display || "");
      }

      summary = valueStr ? `Measured value: ${valueStr}` : "Clinical evaluation completed.";
      break;
    }

    case "Encounter": {
      category = "Consultation / OPD Encounter";
      const reason = res.reasonCode as Array<{ text?: string; coding?: Array<{ display?: string }> }> | undefined;
      const classObj = res.class as { display?: string; code?: string } | undefined;
      const classDisplay = classObj?.display || classObj?.code || "Ambulatory Encounter";

      title = reason?.[0]?.text
        ? sanitizeClinicalString(reason[0].text)
        : `Encounter (${sanitizeClinicalString(classDisplay)})`;

      summary = `Care context encounter documented. Class: ${sanitizeClinicalString(classDisplay)}. Status: ${status}.`;
      break;
    }

    case "MedicationRequest": {
      category = "Prescriptions & Medications";
      const med = res.medicationCodeableConcept as { text?: string; coding?: Array<{ display?: string }> } | undefined;
      title = sanitizeClinicalString(med?.text || med?.coding?.[0]?.display || "Prescription Order");

      const dosage = res.dosageInstruction as Array<{ text?: string }> | undefined;
      if (dosage?.[0]?.text) {
        summary = `Dosage: ${sanitizeClinicalString(dosage[0].text)}`;
      } else {
        summary = "Medication prescribed according to clinical protocol.";
      }
      break;
    }

    case "MedicationDispense": {
      category = "Pharmacy Fulfillment";
      const med = res.medicationCodeableConcept as { text?: string; coding?: Array<{ display?: string }> } | undefined;
      title = sanitizeClinicalString(med?.text || med?.coding?.[0]?.display || "Medication Dispensed");

      const qty = res.quantity as { value?: number; unit?: string } | undefined;
      if (qty?.value) {
        summary = `Dispensed: ${qty.value} ${sanitizeClinicalString(qty.unit || "units")}`;
      } else {
        summary = "Prescription medication dispensed by authorized pharmacy.";
      }
      break;
    }

    case "Immunization": {
      category = "Vaccination / Immunization";
      const vac = res.vaccineCode as { text?: string; coding?: Array<{ display?: string }> } | undefined;
      title = sanitizeClinicalString(vac?.text || vac?.coding?.[0]?.display || "Immunization Record");

      const lot = res.lotNumber ? ` (Lot #${sanitizeClinicalString(res.lotNumber)})` : "";
      summary = `Vaccine administration completed${lot}. Primary source verified.`;
      break;
    }

    case "DocumentReference": {
      category = "Clinical Documents";
      title = sanitizeClinicalString(res.description || "Clinical Document");
      const contentType = (res.content as Array<{ attachment?: { contentType?: string } }>)?.[0]?.attachment?.contentType;
      summary = `Archived clinical document reference (${sanitizeClinicalString(contentType || "application/pdf")}).`;
      break;
    }

    case "ServiceRequest": {
      category = "Diagnostic & Referral Orders";
      const code = res.code as { text?: string; coding?: Array<{ display?: string }> } | undefined;
      title = sanitizeClinicalString(code?.text || code?.coding?.[0]?.display || "Service Referral Request");
      summary = `Priority: ${sanitizeClinicalString(res.priority || "routine")}. Intent: ${sanitizeClinicalString(res.intent || "order")}.`;
      break;
    }

    default:
      summary = "Synthetic HL7 FHIR R4 resource exchanged.";
      break;
  }

  return {
    title,
    category,
    summary,
    date: formattedDate,
    status,
    performer,
    details,
  };
}
