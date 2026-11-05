/**
 * SwasthSaarthi — OTP Delivery & ABHA Mock Authentication Types
 * 
 * Strict separation between:
 * 1. Contact verification (real SMS / Email OTP delivery)
 * 2. Mock ABHA identity provider (synthetic simulation for college project)
 * 3. Application session and authorization DAL
 */

export type OtpChannel = "sms" | "email" | "mock";

export type OtpDeliveryMode = "mock" | "real" | "hybrid";

export interface SendOtpParams {
  destination: string;
  otp: string;
  ttlSeconds: number;
  maskedDestination: string;
  userName?: string;
  purpose?: string;
}

export interface OtpDeliveryResult {
  success: boolean;
  channel: OtpChannel;
  provider: string;
  destinationMasked: string;
  messageId?: string;
  error?: string;
}

export interface OtpDeliveryProvider {
  readonly channel: OtpChannel;
  readonly name: string;
  isConfigured(): boolean;
  sendOtp(params: SendOtpParams): Promise<OtpDeliveryResult>;
}

export interface EmailOtpDeliveryProvider extends OtpDeliveryProvider {
  readonly channel: "email";
}

export interface SmsOtpDeliveryProvider extends OtpDeliveryProvider {
  readonly channel: "sms";
}

export interface MockAbhaIdentity {
  abhaId: string;
  abhaAddress: string;
  name: string;
  role: string;
  phone: string;
  email?: string;
  gender?: string;
  dateOfBirth?: string;
  facility?: string;
  specialization?: string;
  isActive: boolean;
  isMock: true;
}

export interface MockAbhaIdentityProvider {
  resolveIdentity(identifier: string): Promise<MockAbhaIdentity | null>;
}

export interface CreateChallengeInput {
  identifier: string;
  channel?: OtpChannel;
  preferredChannel?: OtpChannel;
  contact?: string; // Optional user-provided phone or email
  clientIp?: string;
  userAgent?: string;
}

export interface ChallengePublicSummary {
  challengeId: string;
  maskedIdentifier: string;
  channel: OtpChannel;
  maskedDestination: string;
  role?: string;
  name?: string;
  expiresAt: string;
  resendAvailableInSeconds: number;
  devOtp?: string;
  demoMode: boolean;
  abdmSimulated: true;
  note: string;
}

export interface VerifyChallengeInput {
  challengeId: string;
  otp: string;
  clientIp?: string;
  userAgent?: string;
}

export interface AvailableChannelsInfo {
  deliveryMode: OtpDeliveryMode;
  channels: Array<{
    id: OtpChannel;
    label: string;
    description: string;
    enabled: boolean;
    requiresConfiguration: boolean;
    configured: boolean;
  }>;
  abdmStatus: "SIMULATED_DEMO_ONLY";
}
