"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { approveBounty } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  owner: string;
  repo: string;
  issueNumber: number;
  totalAmount: number;
  payoutCandidates: Array<{
    githubUsername: string;
    prNumber: number | null;
  }>;
};

type SplitRow = {
  id: string;
  githubUsername: string;
  prNumber: string;
  amount: string;
};

function toCents(amount: string): number {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function ApproveButton({ owner, repo, issueNumber, totalAmount, payoutCandidates }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [successTxHash, setSuccessTxHash] = useState<string | null>(null);
  const [useSplitPayout, setUseSplitPayout] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitRow[]>(() =>
    payoutCandidates.length > 0
      ? payoutCandidates.map((candidate, index) => ({
          id: `${candidate.githubUsername}-${candidate.prNumber ?? "no-pr"}-${index}`,
          githubUsername: candidate.githubUsername,
          prNumber: candidate.prNumber ? String(candidate.prNumber) : "",
          amount: index === 0 ? totalAmount.toFixed(2) : "0.00",
        }))
      : [
          {
            id: "winner",
            githubUsername: "",
            prNumber: "",
            amount: totalAmount.toFixed(2),
          },
        ],
  );

  const allocatedCents = useMemo(
    () => splitRows.reduce((sum, row) => sum + toCents(row.amount), 0),
    [splitRows],
  );
  const totalCents = Math.round(totalAmount * 100);
  const splitIsBalanced = allocatedCents === totalCents;

  const onApprove = () => {
    setError(null);
    setSuccessTxHash(null);

    startTransition(async () => {
      try {
        const splitPayouts = useSplitPayout
          ? splitRows
              .filter((row) => toCents(row.amount) > 0)
              .map((row) => ({
                githubUsername: row.githubUsername,
                amount: toCents(row.amount) / 100,
                prNumber: row.prNumber.trim() ? Number(row.prNumber) : null,
              }))
          : undefined;
        const response = await approveBounty({ owner, repo, issueNumber, splitPayouts });
        const { payoutType, recipientEmail, recipientWallet } = response.payout;
        
        let message = "";
        if (response.payout.payouts && response.payout.payouts.length > 1) {
          message = `Split payout sent to ${response.payout.payouts.length} recipients`;
        } else if (payoutType === "wallet" && recipientWallet) {
          message = `Payout sent to wallet ${recipientWallet.slice(0, 6)}...${recipientWallet.slice(-4)}`;
        } else if (payoutType === "email" && recipientEmail) {
          message = `Payout sent to ${recipientEmail}`;
        } else if (payoutType === "unclaimed") {
          message = "Winner not connected. Notified via issue comment to claim.";
        }
        
        setSuccessTxHash(message);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to approve payout");
      }
    });
  };

  const updateSplitRow = (id: string, patch: Partial<SplitRow>) => {
    setSplitRows((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  const addSplitRow = () => {
    setSplitRows((rows) => [
      ...rows,
      {
        id: `manual-${Date.now()}`,
        githubUsername: "",
        prNumber: "",
        amount: "0.00",
      },
    ]);
  };

  const removeSplitRow = (id: string) => {
    setSplitRows((rows) => rows.length > 1 ? rows.filter((row) => row.id !== id) : rows);
  };

  return (
    <div className="rounded-2xl border border-emerald-300/30 bg-emerald-400/5 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-emerald-300/80">Maintainer Action</p>
      <p className="mt-2 text-sm text-zinc-300">PR is merged and bounty is locked. Approve payout to release funds.</p>
      <label className="mt-4 flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={useSplitPayout}
          onChange={(event) => setUseSplitPayout(event.target.checked)}
          className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-emerald-400"
        />
        Split payout across contributors
      </label>
      {useSplitPayout ? (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-[1fr_72px_88px_32px] gap-2 text-xs uppercase tracking-[0.12em] text-zinc-500">
            <span>GitHub</span>
            <span>PR</span>
            <span>USDC</span>
            <span />
          </div>
          {splitRows.map((row) => (
            <div key={row.id} className="grid grid-cols-[1fr_72px_88px_32px] gap-2">
              <Input
                value={row.githubUsername}
                onChange={(event) => updateSplitRow(row.id, { githubUsername: event.target.value })}
                placeholder="username"
                className="h-9 border-zinc-700 bg-zinc-950 text-sm text-zinc-100"
              />
              <Input
                value={row.prNumber}
                onChange={(event) => updateSplitRow(row.id, { prNumber: event.target.value.replace(/\D/g, "") })}
                placeholder="#"
                className="h-9 border-zinc-700 bg-zinc-950 text-sm text-zinc-100"
              />
              <Input
                value={row.amount}
                onChange={(event) => updateSplitRow(row.id, { amount: event.target.value })}
                inputMode="decimal"
                className="h-9 border-zinc-700 bg-zinc-950 text-sm text-zinc-100"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeSplitRow(row.id)}
                disabled={splitRows.length === 1}
                className="h-9 w-8 text-zinc-400 hover:text-zinc-100"
              >
                x
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="outline" onClick={addSplitRow} className="border-zinc-700 bg-zinc-950 text-zinc-200">
              Add recipient
            </Button>
            <p className={splitIsBalanced ? "text-sm text-emerald-300" : "text-sm text-amber-300"}>
              ${(allocatedCents / 100).toFixed(2)} / ${totalAmount.toFixed(2)}
            </p>
          </div>
        </div>
      ) : null}
      <Button
        onClick={onApprove}
        disabled={isPending || (useSplitPayout && !splitIsBalanced)}
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
