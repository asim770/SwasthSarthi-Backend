import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { createSession } from "@/lib/auth/session";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/callback/google
 * OAuth2 redirect callback endpoint for Google sign-in
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  const frontendUrl = env.CORS_ALLOWED_ORIGINS.split(",")[0] || "http://localhost:5173";

  if (error || !code) {
    return NextResponse.redirect(`${frontendUrl}/?auth_error=${encodeURIComponent(error || "missing_code")}`);
  }

  try {
    const tokenUrl = "https://oauth2.googleapis.com/token";
    const params = new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID || "",
      client_secret: env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/auth/callback/google",
      grant_type: "authorization_code",
    });

    const exchangeResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!exchangeResponse.ok) {
      return NextResponse.redirect(`${frontendUrl}/?auth_error=code_exchange_failed`);
    }

    const tokenData = await exchangeResponse.json();
    const idToken = tokenData.id_token;

    const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const verifyResponse = await fetch(verifyUrl, { method: "GET" });

    if (!verifyResponse.ok) {
      return NextResponse.redirect(`${frontendUrl}/?auth_error=token_verification_failed`);
    }

    const googlePayload = await verifyResponse.json();
    const email = googlePayload.email?.toLowerCase().trim();

    if (!email) {
      return NextResponse.redirect(`${frontendUrl}/?auth_error=missing_email`);
    }

    await connectToDatabase();
    let user = await User.findOne({ email });

    if (!user) {
      const username = email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "user";
      const randSuffix = Math.floor(1000 + Math.random() * 9000);
      user = await User.create({
        abhaId: `91-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`,
        abhaAddress: `${username}${randSuffix}@sbx`,
        name: googlePayload.name || "Google User",
        role: "patient",
        isActive: true,
        phone: "+91-9876543210",
        email,
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
        verificationStatus: "APPROVED",
        verificationHistory: [
          {
            fromStatus: "PENDING",
            toStatus: "APPROVED",
            changedBy: new mongoose.Types.ObjectId(),
            changedByName: "Google Identity Provider",
            changedAt: new Date(),
            reason: "Verified through Google OAuth Redirect",
          },
        ],
      });
    }

    const { cookieHeaders } = await createSession(user._id, user.role, request);

    const response = NextResponse.redirect(`${frontendUrl}/?login=success`);
    for (const cookie of cookieHeaders) {
      response.headers.append("Set-Cookie", cookie);
    }

    return response;
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(`${frontendUrl}/?auth_error=internal_error`);
  }
}
