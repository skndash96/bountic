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
  totalAmount: number;
};

function parseSplitPayouts(splitText: string) {
  if (!splitText.trim()) return undefined;

  return splitText.trim().split(/\r?\n/).map((line) => {
    const parts = line.split(",").map((value) => value.trim());
    if (parts.length !== 2) return null;

    const [githubUsername, rawAmount] = parts;
    const amount = Number(rawAmount);
    const rawCents = amount * 100;
    if (
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(githubUsername) ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isSafeInteger(Math.round(rawCents)) ||
      Math.abs(rawCents - Math.round(rawCents)) >= 1e-8
    ) {
      return null;
    }
    return { githubUsername, amount };
  });
}

export function ApproveButton({ owner, repo, issueNumber, totalAmount }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [splitText, setSplitText] = useState("");

  const previewSplits = parseSplitPayouts(splitText);
  const validPreviewSplits = previewSplits?.filter(
    (entry): entry is { githubUsername: string; amount: number } => entry !== null,
  );
  const previewTotal = validPreviewSplits?.reduce((sum, entry) => sum + entry.amount, 0) ?? 0;
  const hasSplitInput = splitText.trim().length > 0;
  const hasInvalidSplitRow = previewSplits?.some((entry) => entry === null) ?? false;
  const hasInvalidSplitCount = hasSplitInput && (validPreviewSplits?.length ?? 0) < 2;
  const hasTooManySplits = (validPreviewSplits?.length ?? 0) > 50;
  const hasDuplicateRecipients =
    validPreviewSplits !== undefined &&
    new Set(validPreviewSplits.map((entry) => entry.githubUsername.toLowerCase())).size !== validPreviewSplits.length;
  const hasIncorrectTotal =
    hasSplitInput &&
    Math.round(previewTotal * 100) !== Math.round(totalAmount * 100);
  const splitValidationError = hasInvalidSplitRow
    ? "Use a valid GitHub username and whole-cent USDC amount on every line."
    : hasInvalidSplitCount
      ? "A split payout requires at least two contributors."
      : hasTooManySplits
        ? "A split payout supports at most 50 contributors."
        : hasDuplicateRecipients
          ? "Split payout recipients must be unique."
          : hasIncorrectTotal
            ? `Split total must equal ${totalAmount.toFixed(2)} USDC.`
            : null;

  const onApprove = () => {
    setError(null);
    setSuccessMessage(null);

    startTransition(async () => {
      try {
        const parsedSplits = parseSplitPayouts(splitText);
        if (parsedSplits?.some((entry) => entry === null)) {
          throw new Error("Use a valid GitHub username and whole-cent USDC amount per line, for example: alice, 6.00");
        }
        const splitPayouts = parsedSplits?.filter(
          (entry): entry is { githubUsername: string; amount: number } => entry !== null,
        );

        if (splitPayouts && (splitPayouts.length < 2 || splitPayouts.length > 50)) {
          throw new Error("A split payout requires between 2 and 50 contributors");
        }

        if (splitPayouts && new Set(splitPayouts.map((entry) => entry.githubUsername.toLowerCase())).size !== splitPayouts.length) {
          throw new Error("Split payout recipients must be unique");
        }

        if (
          splitPayouts &&
          Math.round(splitPayouts.reduce((sum, entry) => sum + entry.amount, 0) * 100) !==
            Math.round(totalAmount * 100)
        ) {
          throw new Error("Split amounts must equal the bounty total exactly");
        }

        const response = await approveBounty({ owner, repo, issueNumber, splitPayouts });
        const { payoutType, recipientEmail, recipientWallet, recipients, warnings } = response.payout;

        let message = "";
        if (recipients?.length) {
          message = recipients
            .map((entry) => `@${entry.githubUsername}: $${entry.amount.toFixed(2)} USDC`)
            .join("; ");
        } else if (payoutType === "wallet" && recipientWallet) {
          message = `Payout sent to wallet ${recipientWallet.slice(0, 6)}...${recipientWallet.slice(-4)}`;
        } else if (payoutType === "email" && recipientEmail) {
          message = `Payout sent to ${recipientEmail}`;
        } else if (payoutType === "unclaimed") {
          message = "Winner not connected. Notified via issue comment to claim.";
        }

        if (warnings?.length) {
          message += ` Warning: ${warnings.join("; ")}`;
        }

        setSuccessMessage(message);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to approve payout");
      }
    });
  };

  return (
    <div className="rounded-2xl border border-emerald-300/30 bg-emerald-400/5 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-emerald-300/80">Maintainer Action</p>
      <p className="mt-2 text-sm text-zinc-300">
        PR is merged and bounty is locked. Approve payout to release funds.
      </p>
      <label className="mt-4 block text-sm text-zinc-300">
        Split payout (optional)
        <textarea
          className="mt-2 block w-full rounded border border-zinc-600 bg-zinc-950 p-2 text-white"
          value={splitText}
          onChange={(event) => setSplitText(event.target.value)}
          disabled={isPending}
          rows={3}
          placeholder={"alice, 6.00\nbob, 4.00"}
        />
      </label>
      <p className="mt-2 text-xs text-zinc-400">
        One GitHub username and USDC amount per line. Total must equal ${totalAmount.toFixed(2)}.
        Leave blank for the winning PR author.
      </p>
      {validPreviewSplits?.length ? (
        <div className="mt-3 rounded border border-zinc-700 bg-zinc-950/60 p-3 text-sm text-zinc-300">
          <p className="font-medium text-zinc-200">Payout preview</p>
          {validPreviewSplits.map((entry, index) => (
            <p key={`${entry.githubUsername.toLowerCase()}-${index}`} className="mt-1">
              @{entry.githubUsername}: ${entry.amount.toFixed(2)} USDC
            </p>
          ))}
          <p className="mt-2 text-xs text-zinc-400">
            Total: ${previewTotal.toFixed(2)} / ${totalAmount.toFixed(2)} USDC
          </p>
        </div>
      ) : null}
      {hasSplitInput && splitValidationError ? (
        <p className="mt-2 text-xs text-red-300">{splitValidationError}</p>
      ) : null}
      {hasSplitInput && !splitValidationError ? (
        <p className="mt-2 text-xs text-emerald-300">Split is ready to approve.</p>
      ) : null}
      <Button
        onClick={onApprove}
        disabled={isPending || Boolean(splitValidationError)}
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
      {successMessage ? <p className="mt-3 text-sm text-emerald-300">{successMessage}</p> : null}
    </div>
  );
}
