"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { approveBounty } from "@/lib/api/client";
import { Button } from "@/components/ui/button";

type Props = {
  owner: string;
  repo: string;
  issueNumber: number;
};

export function ApproveButton({ owner, repo, issueNumber }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [successTxHash, setSuccessTxHash] = useState<string | null>(null);

  const onApprove = () => {
    setError(null);
    setSuccessTxHash(null);

    startTransition(async () => {
      try {
        const response = await approveBounty({ owner, repo, issueNumber });
        const payouts = response.payout.payouts ?? [response.payout];

        let message = "";
        if (payouts.length > 1) {
          message = `${payouts.length} payouts sent for $${response.payout.amount.toFixed(2)} USDC total.`;
        } else if (response.payout.payoutType === "wallet" && response.payout.recipientWallet) {
          message = `Payout sent to wallet ${response.payout.recipientWallet.slice(0, 6)}...${response.payout.recipientWallet.slice(-4)}`;
        } else if (response.payout.payoutType === "email" && response.payout.recipientEmail) {
          message = `Payout sent to ${response.payout.recipientEmail}`;
        } else if (response.payout.payoutType === "unclaimed") {
          message = "Winner not connected. Notified via issue comment to claim.";
        }

        setSuccessTxHash(message);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to approve payout");
      }
    });
  };

  return (
    <div className="rounded-2xl border border-emerald-300/30 bg-emerald-400/5 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-emerald-300/80">Maintainer Action</p>
      <p className="mt-2 text-sm text-zinc-300">PR is merged and bounty is locked. Approve payout to release funds.</p>
      <Button
        onClick={onApprove}
        disabled={isPending}
        className="mt-4 h-10 w-full bg-emerald-400 text-black hover:bg-emerald-300"
      >
        {isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Approving...
          </>
        ) : (
          "Approve Payment"
        )}
      </Button>
      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
      {successTxHash ? (
        <p className="mt-3 text-sm text-emerald-300">{successTxHash}</p>
      ) : null}
    </div>
  );
}
