import "server-only";

import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";

const LOCUS_WALLET_REGEX = /<!--\s*(?:bountic-address|locus-wallet):\s*(0x[a-fA-F0-9]{40})\s*-->/i;

export async function resolveWalletAddress(params: {
  prDescription: string | null;
  prAuthorUsername: string;
}): Promise<string | null> {
  if (params.prDescription) {
    const walletMatch = LOCUS_WALLET_REGEX.exec(params.prDescription);

    if (walletMatch) {
      return walletMatch[1];
    }
  }

  const supabase = getSupabaseServiceClient();
  const { data: user } = await supabase
    .from("users")
    .select("locus_wallet_address")
    .eq("github_username", params.prAuthorUsername)
    .maybeSingle();

  if (user?.locus_wallet_address) {
    return user.locus_wallet_address;
  }

  return null;
}