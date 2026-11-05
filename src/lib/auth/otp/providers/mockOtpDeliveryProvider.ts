import crypto from "crypto";
import {
  OtpDeliveryProvider,
  OtpChannel,
  SendOtpParams,
  OtpDeliveryResult,
} from "../types";

export interface MockSentRecord {
  destination: string;
  otp: string;
  channel: OtpChannel;
  timestamp: Date;
  ttlSeconds: number;
  messageId: string;
}

/**
 * MockOtpDeliveryProvider
 * 
 * In-memory provider strictly for automated tests and isolated development demonstrations.
 * Never performs real SMS or Email network dispatches.
 */
export class MockOtpDeliveryProvider implements OtpDeliveryProvider {
  public readonly channel: OtpChannel = "mock";
  public readonly name = "MockOtpDeliveryProvider";

  private sentStore: MockSentRecord[] = [];
  private failNextSend: boolean = false;
  private failureError: string = "Simulated mock provider network failure";

  public isConfigured(): boolean {
    return true;
  }

  public setSimulatedFailure(fail: boolean, errorMessage?: string): void {
    this.failNextSend = fail;
    if (errorMessage) {
      this.failureError = errorMessage;
    }
  }

  public async sendOtp(params: SendOtpParams): Promise<OtpDeliveryResult> {
    if (this.failNextSend) {
      this.failNextSend = false;
      return {
        success: false,
        channel: this.channel,
        provider: this.name,
        destinationMasked: params.maskedDestination,
        error: this.failureError,
      };
    }

    const messageId = `mock-${crypto.randomUUID()}`;
    const record: MockSentRecord = {
      destination: params.destination,
      otp: params.otp,
      channel: this.channel,
      timestamp: new Date(),
      ttlSeconds: params.ttlSeconds,
      messageId,
    };

    this.sentStore.push(record);

    return {
      success: true,
      channel: this.channel,
      provider: this.name,
      destinationMasked: params.maskedDestination,
      messageId,
    };
  }

  public getLastSentOtp(destination?: string): string | undefined {
    if (!destination) {
      const last = this.sentStore[this.sentStore.length - 1];
      return last?.otp;
    }
    const matching = this.sentStore
      .filter((r) => r.destination.toLowerCase() === destination.toLowerCase())
      .slice(-1)[0];
    return matching?.otp;
  }

  public getSentRecords(): MockSentRecord[] {
    return [...this.sentStore];
  }

  public clear(): void {
    this.sentStore = [];
    this.failNextSend = false;
  }
}
