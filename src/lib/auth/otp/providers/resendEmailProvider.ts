import {
  EmailOtpDeliveryProvider,
  SendOtpParams,
  OtpDeliveryResult,
} from "../types";
import { env } from "@/lib/env";

export interface ResendProviderOptions {
  apiKey?: string;
  fromEmail?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

/**
 * ResendEmailProvider
 * 
 * Delivers real email one-time passwords using the official Resend REST API (https://resend.com/docs).
 * OTP verification is strictly decoupled and handled server-side by the challenge service.
 */
export class ResendEmailProvider implements EmailOtpDeliveryProvider {
  public readonly channel = "email" as const;
  public readonly name = "ResendEmailProvider";

  private readonly apiKey?: string;
  private readonly fromEmail: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: ResendProviderOptions = {}) {
    this.apiKey = options.apiKey ?? env.RESEND_API_KEY;
    this.fromEmail = options.fromEmail ?? env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
    this.baseUrl = options.baseUrl ?? "https://api.resend.com";
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  public async sendOtp(params: SendOtpParams): Promise<OtpDeliveryResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        channel: this.channel,
        provider: this.name,
        destinationMasked: params.maskedDestination,
        error: "Resend email provider is not configured. Please supply RESEND_API_KEY in environment.",
      };
    }

    const destination = params.destination.trim().toLowerCase();
    if (!destination.includes("@")) {
      return {
        success: false,
        channel: this.channel,
        provider: this.name,
        destinationMasked: params.maskedDestination,
        error: "Destination email format is invalid.",
      };
    }

    const expiryMinutes = Math.max(1, Math.ceil(params.ttlSeconds / 60));
    const recipientGreeting = params.userName ? `Hello ${params.userName},` : "Hello,";

    const subject = `SwasthSaarthi — Login Verification Code: ${params.otp}`;

    const textContent = [
      `${recipientGreeting}`,
      "",
      `Your verification code for SwasthSaarthi is: ${params.otp}`,
      "",
      `This code will expire in ${expiryMinutes} minute(s).`,
      "",
      "ACADEMIC DEMONSTRATION NOTICE:",
      "This application is a college demonstration of the Ayushman Bharat Digital Mission (ABDM).",
      "Authentications are managed by our local application session engine with mock ABHA credentials.",
      "",
      "If you did not request this login code, please safely disregard this email.",
      "",
      "— SwasthSaarthi Healthcare Portal",
    ].join("\n");

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px 12px; color: #1e293b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    <!-- Header -->
    <tr>
      <td style="background-color: #008080; padding: 24px 32px; text-align: left;">
        <h1 style="color: #ffffff; font-size: 20px; font-weight: 700; margin: 0; letter-spacing: -0.02em;">SwasthSaarthi</h1>
        <p style="color: #ccfbf1; font-size: 12px; margin: 4px 0 0 0;">Ayushman Bharat Digital Health Portal (Academic Demo)</p>
      </td>
    </tr>
    <!-- Content -->
    <tr>
      <td style="padding: 32px;">
        <p style="font-size: 14px; line-height: 1.5; color: #334155; margin-top: 0;">${recipientGreeting}</p>
        <p style="font-size: 14px; line-height: 1.5; color: #334155;">
          Use the following one-time password (OTP) to complete your sign-in to the SwasthSaarthi platform:
        </p>

        <!-- OTP Code Box -->
        <div style="background-color: #f0fdfa; border: 1px dashed #008080; border-radius: 8px; padding: 18px 24px; text-align: center; margin: 24px 0;">
          <span style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace; font-size: 32px; font-weight: 700; color: #008080; letter-spacing: 6px;">
            ${params.otp}
          </span>
        </div>

        <p style="font-size: 13px; color: #64748b; margin: 0 0 16px 0;">
          ⏱️ This verification code is valid for <strong>${expiryMinutes} minutes</strong> and can only be used once. Never share this code with anyone.
        </p>

        <!-- Academic Disclaimer -->
        <div style="background-color: #f8fafc; border-left: 3px solid #008080; padding: 12px 16px; margin-top: 24px; border-radius: 0 6px 6px 0;">
          <p style="font-size: 11px; line-height: 1.4; color: #64748b; margin: 0;">
            <strong>College Demonstration Notice:</strong> SwasthSaarthi simulates ABDM registry records for academic evaluation. Real contact verification is performed via Resend independently of the National Health Authority.
          </p>
        </div>
      </td>
    </tr>
    <!-- Footer -->
    <tr>
      <td style="background-color: #f8fafc; padding: 16px 32px; border-top: 1px solid #e2e8f0; text-align: center;">
        <p style="font-size: 11px; color: #94a3b8; margin: 0;">
          If you did not request this login code, you can safely ignore this email.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      const endpoint = `${this.baseUrl}/emails`;
      const response = await this.fetcher(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [destination],
          subject,
          text: textContent,
          html: htmlContent,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      const responseBody = await response.json().catch(() => null);

      if (!response.ok) {
        const errorMsg =
          responseBody?.message ||
          responseBody?.error ||
          `Resend API returned status ${response.status}`;

        // Return generic provider failure without leaking auth keys or sensitive server details
        return {
          success: false,
          channel: this.channel,
          provider: this.name,
          destinationMasked: params.maskedDestination,
          error: `Resend delivery failed: ${errorMsg}`,
        };
      }

      return {
        success: true,
        channel: this.channel,
        provider: this.name,
        destinationMasked: params.maskedDestination,
        messageId: responseBody?.id,
      };
    } catch (err) {
      const isTimeout =
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError");

      return {
        success: false,
        channel: this.channel,
        provider: this.name,
        destinationMasked: params.maskedDestination,
        error: isTimeout
          ? "Resend email delivery timed out."
          : "Resend email provider dispatch error.",
      };
    }
  }
}
