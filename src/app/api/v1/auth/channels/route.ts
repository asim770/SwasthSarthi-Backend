import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { otpChallengeService } from "@/lib/auth/otp";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest) {
  const channelsInfo = otpChallengeService.getAvailableChannels();
  return apiSuccess(channelsInfo, request);
}
