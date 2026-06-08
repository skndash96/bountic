import "server-only";

import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { BOUNTIC_ADDRESS_TAG_REGEX, LOCUS_WALLET_TAG_REGEX } from "@/lib/constants/bounty";

export async function resolveWalletAddress(params: {
  prDescription: string | null;
  prAuthorUsername: string;
}): Promise<string | null> {
  if (params.prDescription) {
    const walletMatch =
      BOUNTIC_ADDRESS_TAG_REGEX.exec(params.prDescription) ??
      LOCUS_WALLET_TAG_REGEX.exec(params.prDescription);

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
