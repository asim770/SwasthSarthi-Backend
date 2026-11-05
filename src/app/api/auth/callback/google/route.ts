import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { createSession } from "@/lib/auth/session";
import { generateUniquePatientId } from "@/lib/auth/patientId";
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

  const frontendUrl = env.CORS_ALLOWED_ORIGINS.split(",")[0] || "http://localhost:3000";

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
      console.error("Google OAuth token exchange failed:", await exchangeResponse.text());
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
    const googleSub = googlePayload.sub?.trim();

    if (!email) {
      return NextResponse.redirect(`${frontendUrl}/?auth_error=missing_email`);
    }

    await connectToDatabase();
    
    // Look up by Google Subject or verified email address
    let user = googleSub ? await User.findOne({ googleSubject: googleSub }) : null;
    if (!user) {
      user = await User.findOne({ email });
    }

    if (!user) {
      const patientId = await generateUniquePatientId();
      const username = email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "patient";
      const randSuffix = Math.floor(1000 + Math.random() * 9000);
      user = await User.create({
        patientId,
        abhaId: `91-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`,
        abhaAddress: `${username}${randSuffix}@sbx`,
        name: googlePayload.name || "Google Patient",
        role: "patient",
        isActive: true,
        accountStatus: "active",
        phone: "+91-9876543210",
        email,
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
        googleSubject: googleSub,
        authProviders: ["google"],
        lastLoginAt: new Date(),
        verificationStatus: "APPROVED",
        verificationHistory: [
          {
            fromStatus: "PENDING",
            toStatus: "APPROVED",
            changedBy: new mongoose.Types.ObjectId(),
            changedByName: "Google Identity Provider",
            changedAt: new Date(),
            reason: `Verified and assigned Patient ID ${patientId} through Google OAuth Redirect`,
          },
        ],
      });
    } else {
      // Ensure patientId is assigned and google credentials linked
      if (!user.patientId) {
        user.patientId = await generateUniquePatientId();
      }
      if (googleSub && !user.googleSubject) {
        user.googleSubject = googleSub;
      }
      if (!user.authProviders?.includes("google")) {
        user.authProviders = [...(user.authProviders || []), "google"];
      }
      user.isEmailVerified = true;
      user.lastLoginAt = new Date();
      await user.save();
    }

    const { cookieHeaders } = await createSession(user._id, user.role, request);

    const response = NextResponse.redirect(`${frontendUrl}/dashboard?login=success`);
    for (const cookie of cookieHeaders) {
      response.headers.append("Set-Cookie", cookie);
    }

    return response;
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(`${frontendUrl}/?auth_error=internal_error`);
  }
}
