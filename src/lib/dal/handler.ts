import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError } from "./errors";
import { apiError } from "@/lib/api/response";

/**
 * Standardized DAL error-to-HTTP response translator
 */
export function handleDalError(err: unknown, request: Request): NextResponse {
  if (err instanceof AuthorizationError) {
    return apiError(err, request, {
      status: err.statusCode,
      code: err.code,
      fallbackMessage: err.message,
    });
  }

  if (err instanceof z.ZodError) {
    return apiError(err, request, {
      status: 400,
      code: "VALIDATION_ERROR",
    });
  }

  console.error("Unhandled DAL Route Error:", err);
  return apiError(err, request, {
    status: 500,
    code: "INTERNAL_ERROR",
    fallbackMessage: "An error occurred while processing the secure request.",
  });
}
