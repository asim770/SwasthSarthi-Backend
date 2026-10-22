import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { validateSession } from "@/lib/auth/session";
import { generateCsrfToken } from "@/lib/security/crypto";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest) {
  try {
    const result = await validateSession(request);

    if (!result.user || !result.session) {
      return apiError(
        new Error("No active or valid session found."),
        request,
        {
          status: 401,
          code: "UNAUTHENTICATED",
          fallbackMessage: "Sign in required to access user profile.",
        }
      );
    }

    const { user, session } = result;
    const csrfToken = generateCsrfToken(session.csrfSecret);

    return apiSuccess(
      {
        user: {
          id: user._id.toString(),
          abhaId: user.abhaId,
          abhaAddress: user.abhaAddress,
          name: user.name,
          role: user.role,
          phone: user.phone,
          facility: user.facility,
          specialization: user.specialization,
          isActive: user.isActive,
          email: user.email,
          gender: user.gender,
          dateOfBirth: user.dateOfBirth,
        },
        session: {
          expiresAt: session.expiresAt.toISOString(),
          lastActivityAt: session.lastActivityAt.toISOString(),
        },
        csrfToken,
      },
      request
    );
  } catch (error) {
    return apiError(error, request, {
      status: 500,
      code: "PROFILE_FETCH_FAILED",
      fallbackMessage: "Failed to retrieve user session profile.",
    });
  }
}
