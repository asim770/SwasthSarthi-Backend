import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/api/cors";
import { env } from "@/lib/env";
import { ZodError } from "zod";

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
  timestamp: string;
}

export interface ApiErrorDetail {
  field?: string;
  message: string;
  code?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
  };
  timestamp: string;
}

export function apiSuccess<T>(
  data: T,
  request: Request | NextRequest,
  options: {
    status?: number;
    meta?: Record<string, unknown>;
    headers?: Record<string, string>;
    cookies?: string[];
  } = {}
): NextResponse<ApiSuccessResponse<T>> {
  const { status = 200, meta, headers: extraHeaders = {}, cookies = [] } = options;
  const corsHeaders = getCorsHeaders(request);

  const payload: ApiSuccessResponse<T> = {
    success: true,
    data,
    ...(meta ? { meta } : {}),
    timestamp: new Date().toISOString(),
  };

  const response = NextResponse.json(payload, {
    status,
    headers: {
      ...corsHeaders,
      ...extraHeaders,
    },
  });

  for (const cookie of cookies) {
    response.headers.append("Set-Cookie", cookie);
  }

  return response;
}

export function apiError(
  error: unknown,
  request: Request | NextRequest,
  options: {
    status?: number;
    fallbackMessage?: string;
    code?: string;
    cookies?: string[];
  } = {}
): NextResponse<ApiErrorResponse> {
  const { status = 500, fallbackMessage = "An unexpected error occurred", code, cookies = [] } = options;
  const corsHeaders = getCorsHeaders(request);

  let statusCode = status;
  let errorCode = code || "INTERNAL_SERVER_ERROR";
  let errorMessage = fallbackMessage;
  let details: ApiErrorDetail[] | undefined = undefined;

  if (error instanceof ZodError) {
    statusCode = 400;
    errorCode = "VALIDATION_ERROR";
    errorMessage = "Invalid request payload or parameters";
    details = error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }));
  } else if (error instanceof Error) {
    if (env.NODE_ENV !== "production") {
      errorMessage = error.message;
    }
  }

  const payload: ApiErrorResponse = {
    success: false,
    error: {
      code: errorCode,
      message: errorMessage,
      ...(details ? { details } : {}),
    },
    timestamp: new Date().toISOString(),
  };

  const response = NextResponse.json(payload, {
    status: statusCode,
    headers: corsHeaders,
  });

  for (const cookie of cookies) {
    response.headers.append("Set-Cookie", cookie);
  }

  return response;
}
