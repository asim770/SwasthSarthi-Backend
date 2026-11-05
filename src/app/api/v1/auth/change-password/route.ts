import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { validateSession } from "@/lib/auth/session";
import { verifyPassword, hashPassword } from "@/lib/security/crypto";
import { logAuditEvent } from "@/lib/dal/audit";

export const dynamic = "force-dynamic";

const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z
    .string()
    .min(8, "New password must be at least 8 characters long")
    .max(128)
    .regex(
      /^(?=.*[A-Za-z])(?=.*\d).*$/,
      "New password must contain at least one letter and at least one number"
    ),
});

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

/**
 * POST /api/v1/auth/change-password
 * Authenticated password change endpoint. Verifies current password before updating.
 */
export async function POST(request: NextRequest) {
  try {
    const sessionResult = await validateSession(request);

    if (!sessionResult.user) {
      return apiError(new Error("Active authentication session required."), request, {
        status: 401,
        code: "UNAUTHENTICATED",
      });
    }

    const body = await request.json().catch(() => null);
    const parseResult = changePasswordSchema.safeParse(body);

    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { currentPassword, newPassword } = parseResult.data;

    await connectToDatabase();

    const user = await User.findById(sessionResult.user._id).select("+passwordHash");

    if (!user) {
      return apiError(new Error("User not found."), request, {
        status: 404,
        code: "USER_NOT_FOUND",
      });
    }

    // If a password was previously established, verify current password
    if (user.passwordHash) {
      if (!currentPassword) {
        return apiError(new Error("Current password is required to change password."), request, {
          status: 400,
          code: "CURRENT_PASSWORD_REQUIRED",
          fallbackMessage: "Please provide your current password.",
        });
      }

      const isValid = await verifyPassword(currentPassword, user.passwordHash);
      if (!isValid) {
        return apiError(new Error("Incorrect current password."), request, {
          status: 401,
          code: "INCORRECT_PASSWORD",
          fallbackMessage: "Current password is incorrect.",
        });
      }
    }

    // Hash new password and persist reliably with Mongoose select:false
    const newHash = await hashPassword(newPassword);
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash: newHash,
        },
        $addToSet: {
          authProviders: "password",
        },
      }
    );

    // Audit log
    try {
      await logAuditEvent({
        action: "AUTH_PASSWORD_CHANGE_SUCCESS",
        principal: {
          id: user._id.toString(),
          role: user.role,
        },
        targetResourceType: "User",
        targetPatientId: user._id,
        outcome: "ALLOWED",
        metadata: {
          patientId: user.patientId,
        },
      });
    } catch {
      // Non-blocking audit error
    }

    return apiSuccess(
      {
        success: true,
        message: "Your password has been successfully updated.",
      },
      request,
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to change password.";
    return apiError(error, request, {
      status: 500,
      code: "PASSWORD_CHANGE_FAILED",
      fallbackMessage: message,
    });
  }
}
