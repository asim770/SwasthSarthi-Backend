import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { validateSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest) {
  const result = await validateSession(request);

  if (!result.user || !result.session) {
    return apiSuccess(
      {
        authenticated: false,
      },
      request
    );
  }

  return apiSuccess(
    {
      authenticated: true,
      user: {
        id: result.user._id.toString(),
        name: result.user.name,
        role: result.user.role,
        abhaAddress: result.user.abhaAddress,
      },
      expiresAt: result.session.expiresAt.toISOString(),
    },
    request
  );
}
