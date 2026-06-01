import "server-only";

import crypto from "node:crypto";

import type { LocusClient, LocusRequestOptions } from "@/lib/clients/locus/server";
import { getSupabaseServerEnv } from "@/lib/env/server";

type CheckoutSessionPayload = {
  id: string;
  checkout_url: string;
  webhook_secret: string;
  mock_webhook_url: string;
};

type PayoutPayload = {
  transaction_id: string;
  tx_hash: string;
};

const MOCK_SECRET = "locus_mock_secret";

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function buildCheckoutUrl(sessionId: string): string {
  const env = getSupabaseServerEnv();
  const baseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  return `${baseUrl}/mock-checkout/${sessionId}`;
}

function buildTxHash(transactionId: string): string {
  return `0x${crypto.createHash("sha256").update(transactionId).digest("hex").slice(0, 64)}`;
}

export function getMockLocusClient(): LocusClient {
  return {
    async request<T>(path: string, options: LocusRequestOptions = {}): Promise<T> {
      const normalized = path.startsWith("/") ? path : `/${path}`;

      if (normalized === "/checkout/sessions" && options.method === "POST") {
        const id = randomId("checkout");
        const env = getSupabaseServerEnv();
        const baseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
        const payload: CheckoutSessionPayload = {
          id,
          checkout_url: buildCheckoutUrl(id),
          webhook_secret: MOCK_SECRET,
          mock_webhook_url: `${baseUrl}/api/webhooks/locus/mock`,
        };

        return payload as T;
      }

      if ((normalized === "/pay/send" || normalized === "/pay/send-email") && options.method === "POST") {
        const transactionId = randomId("tx");
        const payload: PayoutPayload = {
          transaction_id: transactionId,
          tx_hash: buildTxHash(transactionId),
        };

        return payload as T;
      }

      throw new Error(`Mock Locus client does not support ${options.method ?? "GET"} ${normalized}`);
    },

    verifyWebhookSignature(): boolean {
      return true;
    },

    verifyWebhookSignatureWithSecret(): boolean {
      return true;
    },
  };
}
