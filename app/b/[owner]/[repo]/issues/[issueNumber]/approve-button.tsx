"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { approveBounty } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { buildPayoutPlan, parsePayoutShares } from "@/lib/bounty/payout-plan";

type Props = {
  owner: string;
  repo: string;
  issueNumber: number;
  totalAmount: number;
};

export function ApproveButton({ owner, repo, issueNumber, totalAmount }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [successTxHash, setSuccessTxHash] = useState<string | null>(null);
  const [splitText, setSplitText] = useState("");
  let splitError: string | null = null;
  let plan: ReturnType<typeof buildPayoutPlan> | undefined;
  if (splitText.trim()) {
    try { plan = buildPayoutPlan(totalAmount, parsePayoutShares(splitText)); }
    catch (e) { splitError = e instanceof Error ? e.message : "Invalid split"; }
  }

  const onApprove = () => {
    setError(null);
    setSuccessTxHash(null);

    startTransition(async () => {
      try {
        if (splitError) throw new Error(splitError);
        const response = await approveBounty({ owner, repo, issueNumber,
          shares: plan?.map(({ username, basisPoints }) => ({ username, basisPoints })),
        });
        const { payoutType, recipientEmail, recipientWallet } = response.payout;
        
        let message = "";
        if (payoutType === "split") {
          message = response.payout.recipients.map((entry) => `@${entry.username}: $${entry.amount.toFixed(2)} USDC`).join("; ");
        } else if (payoutType === "wallet" && recipientWallet) {
          message = `Payout sent to wallet ${recipientWallet.slice(0, 6)}...${recipientWallet.slice(-4)}`;
        } else if (payoutType === "email" && recipientEmail) {
          message = `Payout sent to ${recipientEmail}`;
        } else if (payoutType === "unclaimed") {
          message = "Winner not connected. Notified via issue comment to claim.";
        }
        
        setSuccessTxHash([message, response.payout.syncWarning].filter(Boolean).join(". "));
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
      <label className="mt-4 block text-sm text-zinc-300">
        Split between contributors (optional)
        <textarea
          className="mt-2 block w-full rounded border border-zinc-600 bg-zinc-950 p-2 text-white"
          value={splitText} onChange={(event) => setSplitText(event.target.value)}
          disabled={isPending || !!successTxHash} rows={3}
          placeholder={"alice, 60\nbob, 40"}
        />
      </label>
      <p className="mt-2 text-xs text-zinc-400">One GitHub username and percentage per line, totaling 100%. Leave blank to pay the PR author. Other recipients must connect a payout email.</p>
      {splitError ? <p role="alert" className="mt-2 text-sm text-red-300">{splitError}</p> : null}
      {plan ? <ul className="mt-2 text-sm text-emerald-300">{plan.map((entry) => (
        <li key={entry.username}>@{entry.username}: ${entry.amount.toFixed(2)} USDC</li>
      ))}</ul> : null}
      <Button
        onClick={onApprove}
        disabled={isPending || !!splitError || !!successTxHash}
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
