import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    // Automatically allow any Vercel domain (production, preview, staging)
    if (parsed.hostname.endsWith(".vercel.app") || parsed.hostname === "vercel.app") {
      return true;
    }
    // Automatically allow local development origins
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return true;
    }
  } catch {
    // Malformed origin
  }
  return false;
}

export function getCorsHeaders(request: Request | NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, Accept, x-csrf-token, X-CSRF-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  // Strict origin verification against allowed whitelist and trusted hosting
  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  } else if (!origin) {
    // Server-to-server or same-origin direct calls without origin header
    headers["Access-Control-Allow-Origin"] = allowedOrigins[0] || "*";
    if (allowedOrigins[0]) {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  }

  return headers;
}

export function handleCorsPreflight(request: Request | NextRequest): NextResponse {
  const headers = getCorsHeaders(request);
  return new NextResponse(null, {
    status: 204,
    headers,
  });
}
