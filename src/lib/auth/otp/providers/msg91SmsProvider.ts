import {
  SmsOtpDeliveryProvider,
  SendOtpParams,
  OtpDeliveryResult,
} from "../types";
import { normalizePhoneNumber } from "../phoneUtils";
import { env } from "@/lib/env";

export interface Msg91ProviderOptions {
  authKey?: string;
  templateId?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

/**
 * Msg91SmsProvider
 * 
 * Delivers real SMS one-time passwords using the official MSG91 OTP v5 API (https://docs.msg91.com/otp).
 * Normalizes phone numbers with libphonenumber-js and dispatches our backend-generated OTP
 * so that verification remains 100% server-authoritative.
 */
export class Msg91SmsProvider implements SmsOtpDeliveryProvider {
  public readonly channel = "sms" as const;
  public readonly name = "Msg91SmsProvider";

  private readonly authKey?: string;
  private readonly templateId?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: Msg91ProviderOptions = {}) {
    this.authKey = options.authKey ?? env.MSG91_AUTH_KEY;
    this.templateId = options.templateId ?? env.MSG91_OTP_TEMPLATE_ID;
    this.baseUrl = options.baseUrl ?? "https://control.msg91.com/api/v5";
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  public isConfigured(): boolean {
    return Boolean(
      this.authKey &&
      this.authKey.trim().length > 0 &&
      this.templateId &&
      this.templateId.trim().length > 0
    );
  }

  public async sendOtp(params: SendOtpParams): Promise<OtpDeliveryResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        channel: this.channel,
        provider: this.name,
        destinationMasked: params.maskedDestination,
        error: "MSG91 SMS provider is not configured. Supply MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID in environment.",
      };
    }

    const norm = normalizePhoneNumber(params.destination);
    if (!norm.isValid || !norm.digitsOnly) {
      return {
        success: false,
        channel: this.channel,
        provider: this.name,
        destinationMasked: params.maskedDestination,
        error: norm.error || "Phone number is not a valid recognized telephone number.",
      };
    }

    const expiryMinutes = Math.max(1, Math.ceil(params.ttlSeconds / 60));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      // MSG91 Send OTP v5 API allows query parameters combined with JSON payload
      const url = new URL(`${this.baseUrl}/otp`);
      url.searchParams.set("template_id", this.templateId!);
      url.searchParams.set("mobile", norm.digitsOnly);
      url.searchParams.set("otp", params.otp);
      url.searchParams.set("otp_expiry", String(expiryMinutes));
      url.searchParams.set("authkey", this.authKey!);

      const response = await this.fetcher(url.toString(), {
        method: "POST",
        headers: {
          authkey: this.authKey!,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          otp: params.otp,
          Param1: params.otp,
          app_name: "SwasthSaarthi",
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      const responseBody = await response.json().catch(() => null);

      if (!response.ok) {
        const errorMsg =
          responseBody?.message ||
          responseBody?.error ||
          `MSG91 returned HTTP ${response.status}`;

        return {
          success: false,
          channel: this.channel,
          provider: this.name,
          destinationMasked: params.maskedDestination,
          error: `MSG91 SMS dispatch failed: ${errorMsg}`,
        };
      }

      // Check MSG91 JSON status: { type: "success" | "error", message: string }
      if (responseBody?.type === "error") {
        return {
          success: false,
          channel: this.channel,
          provider: this.name,
          destinationMasked: params.maskedDestination,
          error: `MSG91 error: ${responseBody.message || "Failed to dispatch SMS OTP"}`,
        };
      }

      return {
        success: true,
        channel: this.channel,
        provider: this.name,
        destinationMasked: params.maskedDestination,
        messageId: responseBody?.message || "msg91_dispatched",
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
          ? "MSG91 SMS delivery request timed out."
          : "MSG91 SMS provider dispatch network error.",
      };
    }
  }
}
