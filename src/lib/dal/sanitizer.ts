import { InvalidQueryError } from "./errors";

/**
 * Recursively inspect user-supplied query parameters or objects
 * and reject any MongoDB query operators (starting with '$' or containing '.')
 */
export function assertSafeQueryInput(input: unknown, path = ""): void {
  if (input === null || input === undefined) {
    return;
  }

  if (typeof input === "string") {
    // Check for obvious NoSQL injection string patterns if used in raw contexts
    return;
  }

  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      assertSafeQueryInput(input[i], `${path}[${i}]`);
    }
    return;
  }

  if (typeof input === "object") {
    for (const key of Object.keys(input)) {
      if (key.startsWith("$") || key.includes(".")) {
        throw new InvalidQueryError(
          `Untrusted query parameter key '${key}' detected at ${path || "root"}. MongoDB operators are strictly forbidden.`
        );
      }
      assertSafeQueryInput((input as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    }
  }
}

/**
 * Validate that an ID parameter is a safe alphanumeric/hyphenated string
 */
export function assertSafeIdentifier(id: unknown, fieldName = "id"): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new InvalidQueryError(`Field '${fieldName}' must be a non-empty string.`);
  }

  const trimmed = id.trim();
  // Safe alphanumeric, hyphen, underscore, colon, and period
  const safeIdRegex = /^[a-zA-Z0-9_\-.:@]+$/;
  if (!safeIdRegex.test(trimmed) || trimmed.length > 128) {
    throw new InvalidQueryError(
      `Field '${fieldName}' contains invalid or forbidden characters.`
    );
  }

  return trimmed;
}
