import "server-only";

import { z } from "zod";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServerEnv, isEnvironmentProduction } from "@/lib/env/server";
import type { CheckoutSession } from "@/lib/bounty/schemas/payloads";

export function toCurrencyAmount(amount: number): string {
  return amount.toFixed(2);
}

export function extractCheckoutSession(payload: unknown): CheckoutSession {
  const candidate = z
    .object({
      id: z.string().optional(),
      sessionId: z.string().optional(),
      checkoutUrl: z.string().url().optional(),
      url: z.string().url().optional(),
      checkout_url: z.string().url().optional(),
      webhookSecret: z.string().optional(),
      webhook_secret: z.string().optional(),
      session: z
        .object({
          id: z.string().optional(),
          checkoutUrl: z.string().url().optional(),
          url: z.string().url().optional(),
          checkout_url: z.string().url().optional(),
          webhookSecret: z.string().optional(),
          webhook_secret: z.string().optional(),
        })
        .optional(),
    })
    .passthrough()
    .parse(payload);

  const id =
    candidate.id ??
    candidate.sessionId ??
    candidate.session?.id;

  if (!id) {
    throw new Error("Locus checkout response did not include a session id");
  }

  const env = getSupabaseServerEnv();
  const checkoutUrl =
    candidate.checkoutUrl ??
    candidate.checkout_url ??
    candidate.url ??
    candidate.session?.checkoutUrl ??
    candidate.session?.checkout_url ??
    candidate.session?.url ??
    `${env.NEXT_PUBLIC_APP_URL}/checkout/${id}`;

  const webhookSecret =
    candidate.webhookSecret ??
    candidate.webhook_secret ??
    candidate.session?.webhookSecret ??
    candidate.session?.webhook_secret ??
    null;

  return { id, checkoutUrl, webhookSecret };
}

export async function createCheckoutSession(params: {
  issueId: string;
  amount: number;
  funderUsername: string;
  funderDisplayName?: string | null;
  sourceCommentId: number;
  issueUrl?: string;
}): Promise<CheckoutSession> {
  const env = getSupabaseServerEnv();
  const locus = getLocusServerClient();

  const payload = await locus.request<unknown>("/checkout/sessions", {
    method: "POST",
    body: {
      amount: toCurrencyAmount(params.amount),
      description: `Bountic funding for ${params.issueId}`,
      successUrl: params.issueUrl ?? `${env.NEXT_PUBLIC_APP_URL}/explore`,
      cancelUrl: params.issueUrl ?? `${env.NEXT_PUBLIC_APP_URL}/explore`,
      webhookUrl: isEnvironmentProduction() ? `${env.NEXT_PUBLIC_APP_URL}/api/webhooks/locus` : undefined,
      metadata: {
        source: "bountic",
        issueId: params.issueId,
        funderUsername: params.funderUsername,
        funderDisplayName: params.funderDisplayName ?? null,
        sourceCommentId: String(params.sourceCommentId),
      },
    },
  });

  return extractCheckoutSession(payload);
}
