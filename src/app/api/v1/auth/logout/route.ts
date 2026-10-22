import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { requireAuth, invalidateSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);

    if (!authResult.success) {
      return apiError(new Error(authResult.message), request, {
        status: authResult.status,
        code: authResult.code,
      });
    }

    const { clearCookieHeaders } = await invalidateSession(request);

    return apiSuccess(
      {
        message: "Session invalidated and auth cookies cleared.",
      },
      request,
      {
        status: 200,
        cookies: clearCookieHeaders,
      }
    );
  } catch (error) {
    return apiError(error, request, {
      status: 500,
      code: "LOGOUT_FAILED",
      fallbackMessage: "Failed to complete logout process.",
    });
  }
}
