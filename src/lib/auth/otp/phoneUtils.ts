import { parsePhoneNumberFromString, CountryCode } from "libphonenumber-js";

export interface NormalizedPhoneResult {
  isValid: boolean;
  e164?: string;
  national?: string;
  digitsOnly?: string;
  countryCallingCode?: string;
  country?: string;
  error?: string;
}

/**
 * Normalize and validate phone numbers using libphonenumber-js.
 * Defaults to India ('IN') if no international country code is prefixed.
 */
export function normalizePhoneNumber(
  rawPhone: string,
  defaultCountry: CountryCode = "IN"
): NormalizedPhoneResult {
  if (!rawPhone || typeof rawPhone !== "string") {
    return { isValid: false, error: "Phone number is empty or invalid" };
  }

  const cleaned = rawPhone.trim();
  try {
    const phoneNumber = parsePhoneNumberFromString(cleaned, defaultCountry);

    if (!phoneNumber || !phoneNumber.isValid()) {
      return {
        isValid: false,
        error: "Phone number is not a valid recognized telephone number",
      };
    }

    const e164 = phoneNumber.format("E.164"); // e.g. +919876543210
    const digitsOnly = e164.replace(/\D/g, ""); // e.g. 919876543210 (required by MSG91)

    return {
      isValid: true,
      e164,
      national: phoneNumber.formatNational(),
      digitsOnly,
      countryCallingCode: phoneNumber.countryCallingCode,
      country: phoneNumber.country,
    };
  } catch (err) {
    return {
      isValid: false,
      error: err instanceof Error ? err.message : "Phone normalization error",
    };
  }
}

/**
 * Mask a phone number to protect Personally Identifiable Information (PII).
 * e.g. +919876543210 -> +91-98****3210
 */
export function maskPhoneNumber(phone: string): string {
  const norm = normalizePhoneNumber(phone);
  const target = norm.isValid && norm.e164 ? norm.e164 : phone.trim();

  if (target.length <= 6) {
    return "***";
  }

  const visibleStart = target.startsWith("+") ? 6 : 4;
  const visibleEnd = 4;

  if (target.length <= visibleStart + visibleEnd) {
    return `${target.slice(0, 2)}****${target.slice(-2)}`;
  }

  const prefix = target.slice(0, visibleStart);
  const suffix = target.slice(-visibleEnd);
  return `${prefix}****${suffix}`;
}

/**
 * Mask an email address to protect Personally Identifiable Information (PII).
 * e.g. rahul.verma@example.com -> r***a@example.com
 */
export function maskEmailAddress(email: string): string {
  if (!email || !email.includes("@")) {
    return "***@***";
  }

  const [local, domain] = email.trim().toLowerCase().split("@");
  if (!local || !domain) return "***@***";

  if (local.length <= 2) {
    return `${local[0]}*@${domain}`;
  }

  const first = local[0];
  const last = local[local.length - 1];
  return `${first}${"*".repeat(Math.min(local.length - 2, 4))}${last}@${domain}`;
}

/**
 * Mask an ABHA address or ABHA number.
 * e.g. rahul.verma@sbx -> r***a@sbx
 * e.g. 32-8492-1920-4491 -> 32-****-****-4491
 */
export function maskIdentifier(id: string): string {
  const cleaned = id.trim();
  if (cleaned.includes("@")) {
    return maskEmailAddress(cleaned);
  }
  // ABHA 14-digit format
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length === 14) {
    return `${digits.slice(0, 2)}-****-****-${digits.slice(-4)}`;
  }
  if (cleaned.length >= 8) {
    return `${cleaned.slice(0, 3)}-****-${cleaned.slice(-3)}`;
  }
  return `${cleaned.slice(0, 1)}***${cleaned.slice(-1)}`;
}
