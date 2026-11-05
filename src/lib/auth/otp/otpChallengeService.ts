import crypto from "crypto";
import {
  OtpChannel,
  OtpDeliveryMode,
  SendOtpParams,
  OtpDeliveryResult,
  EmailOtpDeliveryProvider,
  SmsOtpDeliveryProvider,
  OtpDeliveryProvider,
  MockAbhaIdentityProvider,
  CreateChallengeInput,
  ChallengePublicSummary,
  VerifyChallengeInput,
  AvailableChannelsInfo,
} from "./types";
import { ResendEmailProvider } from "./providers/resendEmailProvider";
import { Msg91SmsProvider } from "./providers/msg91SmsProvider";
import { MockOtpDeliveryProvider } from "./providers/mockOtpDeliveryProvider";
import { DefaultMockAbhaIdentityProvider } from "./providers/mockAbhaIdentityProvider";
import {
  normalizePhoneNumber,
  maskPhoneNumber,
  maskEmailAddress,
  maskIdentifier,
} from "./phoneUtils";
import { AuthChallenge, IAuthChallenge } from "@/lib/db/models/AuthChallenge";
import { User, IUser } from "@/lib/db/models/User";
import { generateRandomOtp, hashOtp, verifyOtpHash } from "@/lib/security/crypto";
import { checkRateLimit } from "@/lib/security/rateLimiter";
import { logAuditEvent } from "@/lib/dal/audit";
import { connectToDatabase } from "@/lib/db/connect";
import { env } from "@/lib/env";

export interface OtpChallengeServiceOptions {
  emailProvider?: EmailOtpDeliveryProvider;
  smsProvider?: SmsOtpDeliveryProvider;
  mockProvider?: MockOtpDeliveryProvider;
  mockAbhaProvider?: MockAbhaIdentityProvider;
}

export class OtpChallengeService {
  private emailProvider: EmailOtpDeliveryProvider;
  private smsProvider: SmsOtpDeliveryProvider;
  private mockProvider: MockOtpDeliveryProvider;
  private mockAbhaProvider: MockAbhaIdentityProvider;

  constructor(options: OtpChallengeServiceOptions = {}) {
    this.emailProvider = options.emailProvider ?? new ResendEmailProvider();
    this.smsProvider = options.smsProvider ?? new Msg91SmsProvider();
    this.mockProvider = options.mockProvider ?? new MockOtpDeliveryProvider();
    this.mockAbhaProvider =
      options.mockAbhaProvider ?? new DefaultMockAbhaIdentityProvider();
  }

  // Provider injection for automated tests
  public setEmailProvider(provider: EmailOtpDeliveryProvider): void {
    this.emailProvider = provider;
  }

  public setSmsProvider(provider: SmsOtpDeliveryProvider): void {
    this.smsProvider = provider;
  }

  public setMockProvider(provider: MockOtpDeliveryProvider): void {
    this.mockProvider = provider;
  }

  public getMockProvider(): MockOtpDeliveryProvider {
    return this.mockProvider;
  }

  public setMockAbhaProvider(provider: MockAbhaIdentityProvider): void {
    this.mockAbhaProvider = provider;
  }

  /**
   * Return information on available OTP channels based on environment configuration
   */
  public getAvailableChannels(): AvailableChannelsInfo {
    const mode = (env.OTP_DELIVERY_MODE || "mock") as OtpDeliveryMode;
    const channelsEnabled = (env.OTP_CHANNELS_ENABLED || "mock,sms,email")
      .split(",")
      .map((c) => c.trim().toLowerCase());

    const isEmailConfigured = this.emailProvider.isConfigured();
    const isSmsConfigured = this.smsProvider.isConfigured();

    const channels = [];

    // In mock mode or when real providers are unconfigured, place mock channel first
    if (mode !== "real" && channelsEnabled.includes("mock")) {
      channels.push({
        id: "mock" as const,
        label: "Demo Channel (Instant)",
        description: "Isolated mock delivery channel strictly for academic demonstrations & automated tests.",
        enabled: true,
        requiresConfiguration: false,
        configured: true,
      });
    }

    channels.push(
      {
        id: "email" as const,
        label: "Email OTP",
        description: "Delivers real verification OTP to your verified email inbox via Resend.",
        enabled: channelsEnabled.includes("email"),
        requiresConfiguration: true,
        configured: isEmailConfigured,
      },
      {
        id: "sms" as const,
        label: "SMS OTP",
        description: "Delivers real verification OTP to your mobile phone via MSG91 (India DLT).",
        enabled: channelsEnabled.includes("sms"),
        requiresConfiguration: true,
        configured: isSmsConfigured,
      }
    );

    return {
      deliveryMode: mode,
      channels,
      abdmStatus: "SIMULATED_DEMO_ONLY",
    };
  }

  /**
   * Step 1: Create a secure OTP challenge and dispatch OTP via selected provider
   */
  public async createChallenge(
    input: CreateChallengeInput
  ): Promise<ChallengePublicSummary> {
    const clientIp = input.clientIp || "127.0.0.1";
    const isLocalhost =
      clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "localhost";
    const isDevEnv = process.env.NODE_ENV !== "production";

    // 1. Rate-limit challenge creation per IP: 5 in production, 100 in dev for localhost
    const ipLimit = checkRateLimit(
      `otp_ip:${clientIp}`,
      isDevEnv && isLocalhost ? 100 : 5,
      300000
    );
    if (!ipLimit.allowed) {
      throw new Error(
        `Too many OTP requests from this IP address. Please wait ${ipLimit.resetInSeconds}s.`
      );
    }

    if (!input.identifier || typeof input.identifier !== "string") {
      throw new Error("Identifier is required.");
    }

    const trimmedIdentifier = input.identifier.trim();

    // 2. Resolve User identity: check MongoDB database first, then fallback to simulated ABHA provider
    await connectToDatabase();
    let user = await User.findOne({
      $or: [
        { email: trimmedIdentifier.toLowerCase() },
        { patientId: trimmedIdentifier },
        { patientId: trimmedIdentifier.toUpperCase() },
        { abhaAddress: trimmedIdentifier.toLowerCase() },
        { abhaId: trimmedIdentifier },
      ],
    });

    if (user) {
      if (user.isActive === false || user.accountStatus === "suspended") {
        throw new Error("This synthetic identity account has been deactivated.");
      }
    } else {
      const abhaUser = await this.mockAbhaProvider.resolveIdentity(trimmedIdentifier);
      if (!abhaUser) {
        throw new Error("User identity not found. Please check your Patient ID or registered email.");
      }

      if (!abhaUser.isActive) {
        throw new Error("This synthetic identity account has been deactivated.");
      }

      user = await User.findOne({
        $or: [
          { abhaId: abhaUser.abhaId },
          { abhaAddress: abhaUser.abhaAddress.toLowerCase() },
        ],
      });

      if (!user) {
        throw new Error("User record could not be loaded from database.");
      }
    }

    // 3. Determine delivery channel and destination
    const mode = (env.OTP_DELIVERY_MODE || "mock") as OtpDeliveryMode;
    let selectedChannel: OtpChannel = input.channel || "mock";

    // If channel wasn't explicitly requested, select best match
    if (!input.channel) {
      if (input.contact && input.contact.includes("@")) {
        selectedChannel = "email";
      } else if (input.contact && /\d{8,}/.test(input.contact)) {
        selectedChannel = "sms";
      } else if (mode !== "real") {
        selectedChannel = "mock";
      } else if (this.emailProvider.isConfigured()) {
        selectedChannel = "email";
      } else if (this.smsProvider.isConfigured()) {
        selectedChannel = "sms";
      } else {
        selectedChannel = "mock";
      }
    }

    // Validate that mock channel is forbidden in strictly real mode
    if (selectedChannel === "mock" && mode === "real") {
      throw new Error(
        "Mock OTP delivery is disabled in real delivery mode. Please choose SMS or Email."
      );
    }

    let destination = "";
    let maskedDestination = "";

    if (selectedChannel === "email") {
      const emailTarget = (input.contact || user.email || "").trim().toLowerCase();
      if (!emailTarget || !emailTarget.includes("@")) {
        throw new Error("A valid email address is required for Email OTP delivery.");
      }
      destination = emailTarget;
      maskedDestination = maskEmailAddress(emailTarget);
    } else if (selectedChannel === "sms") {
      const phoneTarget = (input.contact || user.phone || "").trim();
      const norm = normalizePhoneNumber(phoneTarget);
      if (!norm.isValid || !norm.e164) {
        throw new Error(
          norm.error || "A valid mobile phone number is required for SMS OTP delivery."
        );
      }
      destination = norm.e164;
      maskedDestination = maskPhoneNumber(norm.e164);
    } else {
      // Mock channel
      const fallbackTarget = (user.abhaAddress || user.email || user.patientId || trimmedIdentifier || "").toLowerCase();
      destination = fallbackTarget;
      maskedDestination = maskIdentifier(fallbackTarget);
    }

    // 4. Rate-limit challenge creation per destination: Max OTP_MAX_SENDS_PER_WINDOW per 5 minutes
    const maxSends = env.OTP_MAX_SENDS_PER_WINDOW || 3;
    const destLimit = checkRateLimit(`otp_dest:${destination.toLowerCase()}`, maxSends, 300000);
    if (!destLimit.allowed) {
      throw new Error(
        `Too many OTP requests for this destination. Please wait ${destLimit.resetInSeconds}s.`
      );
    }

    // 5. Enforce resend cooldown for existing pending challenge for this destination
    const now = new Date();
    const existingActive = await AuthChallenge.findOne({
      destination: destination.toLowerCase(),
      status: "PENDING",
      expiresAt: { $gt: now },
    }).sort({ createdAt: -1 });

    if (
      existingActive &&
      existingActive.resendCooldownUntil &&
      existingActive.resendCooldownUntil > now
    ) {
      const secondsLeft = Math.ceil(
        (existingActive.resendCooldownUntil.getTime() - now.getTime()) / 1000
      );
      throw new Error(
        `Please wait ${secondsLeft} seconds before requesting another verification code.`
      );
    }

    // 6. Generate cryptographic OTP and challenge identifiers
    const otp = generateRandomOtp(); // 6-digit numeric OTP
    const challengeId = crypto.randomUUID();
    const transactionId = `TXN-${crypto.randomUUID()}`;
    const otpHash = hashOtp(otp, challengeId);
    const ttlSeconds = env.OTP_TTL_SECONDS || 300;
    const cooldownSeconds = env.OTP_RESEND_COOLDOWN_SECONDS || 30;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const resendCooldownUntil = new Date(now.getTime() + cooldownSeconds * 1000);

    const sendParams: SendOtpParams = {
      destination,
      otp,
      ttlSeconds,
      maskedDestination,
      userName: user.name,
      purpose: "LOGIN_VERIFICATION",
    };

    // 7. Dispatch OTP through the selected provider
    let deliveryResult: OtpDeliveryResult;

    if (selectedChannel === "email") {
      deliveryResult = await this.emailProvider.sendOtp(sendParams);
      if (!deliveryResult.success) {
        await logAuditEvent({
          action: "AUTH_OTP_DELIVERY_FAILED",
          outcome: "FAILED",
          targetResourceType: "AuthChallenge",
          targetPatientId: user._id,
          denialReason: deliveryResult.error || "Email provider dispatch failure",
          ipAddress: clientIp,
          userAgent: input.userAgent,
          metadata: {
            channel: "email",
            maskedDestination,
            provider: this.emailProvider.name,
          },
        });
        // Never silently fallback to mock in real delivery
        throw new Error(
          deliveryResult.error || "Failed to dispatch email verification code. Please try again."
        );
      }
    } else if (selectedChannel === "sms") {
      deliveryResult = await this.smsProvider.sendOtp(sendParams);
      if (!deliveryResult.success) {
        await logAuditEvent({
          action: "AUTH_OTP_DELIVERY_FAILED",
          outcome: "FAILED",
          targetResourceType: "AuthChallenge",
          targetPatientId: user._id,
          denialReason: deliveryResult.error || "SMS provider dispatch failure",
          ipAddress: clientIp,
          userAgent: input.userAgent,
          metadata: {
            channel: "sms",
            maskedDestination,
            provider: this.smsProvider.name,
          },
        });
        // Never silently fallback to mock in real delivery
        throw new Error(
          deliveryResult.error || "Failed to dispatch SMS verification code. Please try again."
        );
      }
    } else {
      // Mock channel
      deliveryResult = await this.mockProvider.sendOtp(sendParams);
      if (!deliveryResult.success) {
        throw new Error(deliveryResult.error || "Failed to generate mock verification code.");
      }
    }

    // 8. Invalidate any previously pending challenges for this identifier
    const targetIdStr = (user.abhaAddress || user.email || user.patientId || trimmedIdentifier || "").toLowerCase();
    await AuthChallenge.updateMany(
      {
        identifier: targetIdStr,
        status: "PENDING",
      },
      {
        status: "EXPIRED",
      }
    );

    // 9. Persist challenge record in MongoDB
    // devOtp is populated ONLY in non-production environments when using the mock channel
    const isDev =
      env.NODE_ENV !== "production" &&
      mode !== "real" &&
      selectedChannel === "mock";

    await AuthChallenge.create({
      challengeId,
      identifier: targetIdStr,
      channel: selectedChannel,
      destination: destination.toLowerCase(),
      maskedDestination,
      purpose: "LOGIN_VERIFICATION",
      transactionId,
      resendCooldownUntil,
      userId: user._id,
      otpHash,
      devOtp: isDev ? otp : undefined,
      attempts: 0,
      maxAttempts: env.OTP_MAX_ATTEMPTS || 3,
      status: "PENDING",
      expiresAt,
      ipAddress: clientIp,
    });

    // 10. Record security audit log
    await logAuditEvent({
      action: "AUTH_OTP_CHALLENGE_CREATED",
      outcome: "ALLOWED",
      targetResourceType: "AuthChallenge",
      targetResourceId: challengeId,
      targetPatientId: user._id,
      ipAddress: clientIp,
      userAgent: input.userAgent,
      metadata: {
        channel: selectedChannel,
        maskedDestination,
        transactionId,
        provider: deliveryResult.provider,
        demoMode: true,
      },
    });

    return {
      challengeId,
      maskedIdentifier: maskIdentifier(user.abhaAddress || user.email || user.patientId || trimmedIdentifier || ""),
      channel: selectedChannel,
      maskedDestination,
      role: user.role,
      name: user.name,
      expiresAt: expiresAt.toISOString(),
      resendAvailableInSeconds: cooldownSeconds,
      demoMode: true,
      abdmSimulated: true,
      note: "College demonstration mode using synthetic ABHA identities. Contact verification OTP is delivered independently.",
    };
  }

  /**
   * Step 2: Verify challenge OTP, update contact verification status, and return user
   */
  public async verifyChallenge(
    input: VerifyChallengeInput
  ): Promise<{
    user: IUser;
    challenge: IAuthChallenge;
    contactVerified: boolean;
  }> {
    const { challengeId, otp, clientIp, userAgent } = input;

    // 1. Rate-limit OTP attempts per challenge: Max OTP_MAX_VERIFY_ATTEMPTS_PER_WINDOW
    const maxVerifyAttempts = env.OTP_MAX_VERIFY_ATTEMPTS_PER_WINDOW || 5;
    const limitResult = checkRateLimit(
      `verify_challenge:${challengeId}`,
      maxVerifyAttempts,
      300000
    );
    if (!limitResult.allowed) {
      throw new Error(
        `Too many verification attempts for this challenge. Please wait ${limitResult.resetInSeconds}s.`
      );
    }

    await connectToDatabase();

    const now = new Date();
    const existing = await AuthChallenge.findOne({ challengeId });

    if (!existing) {
      throw new Error("Challenge reference does not exist or has expired.");
    }

    if (existing.status === "CONSUMED") {
      throw new Error("This OTP challenge has already been consumed. Replay is forbidden.");
    }

    if (existing.status === "EXHAUSTED" || existing.attempts >= existing.maxAttempts) {
      throw new Error("Maximum verification attempts exceeded. Challenge is locked.");
    }

    if (existing.expiresAt <= now || existing.status === "EXPIRED") {
      existing.status = "EXPIRED";
      await existing.save();
      throw new Error("The OTP challenge has expired. Please request a new one.");
    }

    // 2. Atomic increment of attempt counter to prevent concurrent bypass
    const challenge = await AuthChallenge.findOneAndUpdate(
      {
        challengeId,
        status: "PENDING",
        attempts: { $lt: existing.maxAttempts },
        expiresAt: { $gt: now },
      },
      {
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" }
    );

    if (!challenge) {
      throw new Error("Challenge is no longer valid or is being processed concurrently.");
    }

    // 3. Constant-time comparison of OTP cryptographic hash
    const isOtpValid = verifyOtpHash(otp, challengeId, challenge.otpHash);

    if (!isOtpValid) {
      const attemptsLeft = challenge.maxAttempts - challenge.attempts;

      if (challenge.attempts >= challenge.maxAttempts) {
        challenge.status = "EXHAUSTED";
        await challenge.save();

        await logAuditEvent({
          action: "AUTH_OTP_VERIFICATION_FAILED",
          outcome: "DENIED",
          targetResourceType: "AuthChallenge",
          targetResourceId: challengeId,
          targetPatientId: challenge.userId,
          denialReason: "MAX_ATTEMPTS_EXHAUSTED",
          ipAddress: clientIp,
          userAgent,
          metadata: {
            challengeId,
            attempts: challenge.attempts,
          },
        });

        throw new Error("Maximum verification attempts exceeded. Challenge is locked.");
      }

      await logAuditEvent({
        action: "AUTH_OTP_VERIFICATION_FAILED",
        outcome: "DENIED",
        targetResourceType: "AuthChallenge",
        targetResourceId: challengeId,
        targetPatientId: challenge.userId,
        denialReason: "INVALID_OTP",
        ipAddress: clientIp,
        userAgent,
        metadata: {
          challengeId,
          attempts: challenge.attempts,
          attemptsLeft,
        },
      });

      throw new Error(`Incorrect OTP. ${attemptsLeft} attempt(s) remaining.`);
    }

    // 4. Atomically consume challenge to prevent race conditions
    const consumedResult = await AuthChallenge.findOneAndUpdate(
      { challengeId, status: "PENDING" },
      { status: "CONSUMED", consumedAt: new Date() },
      { returnDocument: "after" }
    );

    if (!consumedResult) {
      throw new Error("Challenge could not be consumed. Possible replay attempt.");
    }

    // 5. Resolve user principal
    const user = await User.findById(challenge.userId);
    if (!user) {
      throw new Error("Associated user not found.");
    }

    if (!user.isActive) {
      throw new Error("User account is inactive or disabled.");
    }

    // 6. Update contact verification status on User model
    let contactVerified = false;
    if (challenge.channel === "sms") {
      user.isPhoneVerified = true;
      user.phoneVerifiedAt = new Date();
      contactVerified = true;
      await user.save();
    } else if (challenge.channel === "email") {
      user.isEmailVerified = true;
      user.emailVerifiedAt = new Date();
      contactVerified = true;
      await user.save();
    }

    // 7. Audit log for successful OTP verification & contact verification
    await logAuditEvent({
      action: "AUTH_OTP_VERIFICATION_SUCCESS",
      outcome: "ALLOWED",
      targetResourceType: "AuthChallenge",
      targetResourceId: challengeId,
      targetPatientId: user._id,
      ipAddress: clientIp,
      userAgent,
      metadata: {
        channel: challenge.channel,
        contactVerified,
        maskedDestination: challenge.maskedDestination,
      },
    });

    if (contactVerified) {
      await logAuditEvent({
        action: "CONTACT_VERIFIED",
        outcome: "ALLOWED",
        targetResourceType: "User",
        targetResourceId: user._id.toString(),
        targetPatientId: user._id,
        ipAddress: clientIp,
        userAgent,
        metadata: {
          verifiedChannel: challenge.channel,
          verifiedAt: new Date().toISOString(),
        },
      });
    }

    return {
      user,
      challenge: consumedResult,
      contactVerified,
    };
  }
}

// Global singleton instance for application route handlers
export const otpChallengeService = new OtpChallengeService();
