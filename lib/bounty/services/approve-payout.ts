import "server-only";

import { callLocusPayoutByEmail, getRecipientEmail, resolveAndPayout, type PayoutResult } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";

export async function approveBountyPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  approvedBy: string;
  splitPayouts?: Array<{ githubUsername: string; amount: number }>;
}) {
  const issueId = buildIssueId(params.owner, params.repo, params.issueNumber);
  const supabase = getSupabaseServiceClient();

  const { data: bounty, error: bountyError } = await supabase
    .from("bounties")
    .select("issue_id, status, total_amount, winning_pr_author, winning_pr_number")
    .eq("issue_id", issueId)
    .maybeSingle();

  if (bountyError) {
    throw new Error(`Failed to load bounty: ${bountyError.message}`);
  }

  if (!bounty) {
    throw new Error("Bounty not found");
  }

  if (bounty.status === "PAID") {
    throw new Error("Bounty has already been paid");
  }

  if (bounty.status !== "LOCKED") {
    throw new Error("Bounty must be LOCKED before payout approval");
  }

  if (!bounty.winning_pr_author) {
    throw new Error("No winning PR author found for payout");
  }

  let winningPrBody: string | null = null;
  if (bounty.winning_pr_number) {
    try {
      const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
      const github = await getGithubInstallationClient(installationId);
      const prResponse = await github.rest.pulls.get({
        owner: params.owner,
        repo: params.repo,
        pull_number: bounty.winning_pr_number,
      });
      winningPrBody = prResponse.data.body ?? null;
    } catch (err) {
      console.warn("Failed to fetch PR body for wallet extraction:", err);
    }
  }

  const requestedSplits = params.splitPayouts ?? [];

  if (requestedSplits.length > 0) {
    if (requestedSplits.length < 2 || requestedSplits.length > 50) {
      throw new Error("Split payouts require between 2 and 50 recipients");
    }

    const normalized = requestedSplits.map((split) => {
      const githubUsername = split.githubUsername.trim();
      const rawCents = split.amount * 100;
      if (
        !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(githubUsername) ||
        !Number.isFinite(split.amount) ||
        !Number.isSafeInteger(Math.round(rawCents)) ||
        Math.abs(rawCents - Math.round(rawCents)) >= 1e-8
      ) {
        throw new Error("Each split requires a valid GitHub username and a whole-cent amount");
      }
      return { githubUsername, cents: Math.round(rawCents) };
    });
    const rawTotalCents = bounty.total_amount * 100;
    if (!Number.isSafeInteger(Math.round(rawTotalCents)) || Math.abs(rawTotalCents - Math.round(rawTotalCents)) >= 1e-8) {
      throw new Error("Bounty total must be a safe whole-cent amount");
    }
    const totalCents = Math.round(rawTotalCents);
    const usernames = normalized.map((split) => split.githubUsername.toLowerCase());

    if (normalized.some((split) => !split.githubUsername || split.cents <= 0)) {
      throw new Error("Every split payout must have a GitHub username and a positive amount");
    }
    if (new Set(usernames).size !== usernames.length) {
      throw new Error("Split payout recipients must be unique");
    }
    if (normalized.reduce((sum, split) => sum + split.cents, 0) !== totalCents) {
      throw new Error("Split payout amounts must equal the bounty total exactly");
    }

    const destinations = await Promise.all(
      normalized.map(async (split) => ({
        ...split,
        email: await getRecipientEmail(split.githubUsername),
      })),
    );
    const unresolved = destinations.find((recipient) => !recipient.email);
    if (unresolved) {
      throw new Error("@" + unresolved.githubUsername + " must connect a payout destination before approval");
    }

    // Freeze the maintainer-approved plan before any transfer. The issue-level
    // primary key arbitrates concurrent approvals and prevents a changed plan from
    // being replayed after a partial or ambiguous send.
    const frozenPlan = destinations.map((recipient) => ({
      githubUsername: recipient.githubUsername,
      cents: recipient.cents,
      email: recipient.email,
    }));
    const { error: batchError } = await supabase.from("payout_batches").insert({
      issue_id: issueId,
      approved_by: params.approvedBy,
      plan: frozenPlan,
    });
    if (batchError) {
      throw new Error("Split payout is already reserved or could not freeze its approved plan; reconciliation is required");
    }

    // Reserve every recipient before any external transfer. The unique
    // split-only (issue_id, recipient_username) index adds recipient-level
    // protection beneath the immutable issue-level batch.
    const reservationRows = destinations.map((recipient) => ({
      issue_id: issueId,
      recipient_username: recipient.githubUsername,
      amount: recipient.cents / 100,
      status: "PENDING" as const,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        split_payout: true,
      },
    }));
    const { data: reservedRows, error: reservationError } = await supabase
      .from("payout_events")
      .insert(reservationRows)
      .select("id");
    if (reservationError || reservedRows?.length !== reservationRows.length) {
      throw new Error("Split payout plan was frozen but every recipient could not be reserved; no transfer was started and reconciliation is required");
    }

    const results: Array<{
      githubUsername: string;
      cents: number;
      email: string | null;
      amount: number;
      result: PayoutResult;
    }> = [];
    for (const recipient of destinations) {
      const amount = recipient.cents / 100;
      let result: PayoutResult;
      try {
        result = await callLocusPayoutByEmail({
          toEmail: recipient.email!,
          amount,
          memo: "Bountic split payout for " + issueId,
        });
      } catch (error) {
        const { data: failedReservation, error: failureUpdateError } = await supabase
          .from("payout_events")
          .update({
            status: "FAILED",
            metadata: {
              approved_by: params.approvedBy,
              payout_source: "web",
              split_payout: true,
              error: error instanceof Error ? error.message : "Unknown payout failure",
            },
          })
          .eq("issue_id", issueId)
          .ilike("recipient_username", recipient.githubUsername)
          .eq("status", "PENDING")
          .contains("metadata", { split_payout: true })
          .select("id")
          .maybeSingle();

        if (failureUpdateError || !failedReservation) {
          console.error("Split payout failed and its reservation could not be marked FAILED:", {
            issueId,
            githubUsername: recipient.githubUsername,
            payoutError: error,
            failureUpdateError: failureUpdateError ?? "reserved payout row was not found",
          });
        }
        throw error;
      }

      const { data: persistedReceipt, error: receiptError } = await supabase
        .from("payout_events")
        .update({
          locus_transaction_id: result.transactionId,
          transaction_hash: result.txHash,
          status: "SUCCESS",
          metadata: {
            approved_by: params.approvedBy,
            payout_source: "web",
            payout_type: result.payoutType,
            recipient_email: result.recipientEmail,
            split_payout: true,
          },
        })
        .eq("issue_id", issueId)
        .ilike("recipient_username", recipient.githubUsername)
        .eq("status", "PENDING")
        .contains("metadata", { split_payout: true })
        .select("id")
        .maybeSingle();

      if (receiptError || !persistedReceipt) {
        // The provider already accepted this transfer. Do not relabel the
        // reservation FAILED or automatically retry it: either action could
        // hide or duplicate money that moved. Preserve the reservation and
        // surface the provider identifiers for operator reconciliation.
        console.error("Split payout transfer succeeded but receipt persistence failed:", {
          issueId,
          githubUsername: recipient.githubUsername,
          transactionId: result.transactionId,
          txHash: result.txHash,
          receiptError: receiptError ?? "reserved payout row was not found",
        });
        throw new Error(
          "Payout transfer may have succeeded but its receipt could not be persisted; manual reconciliation is required",
        );
      }

      results.push({ ...recipient, amount, result });
    }

    const now = new Date().toISOString();
    const { data: paidBounty, error: updateError } = await supabase
      .from("bounties")
      .update({
        status: "PAID",
        payout_tx_hash: results.map(({ result }) => result.txHash).filter(Boolean).join(",") || null,
        paid_at: now,
        approved_by: params.approvedBy,
      })
      .eq("issue_id", issueId)
      .eq("status", "LOCKED")
      .select("issue_id")
      .maybeSingle();
    if (updateError) throw new Error("Failed to update bounty status to PAID: " + updateError.message);
    if (!paidBounty) {
      throw new Error("Bounty state changed during split payout; funds may have moved and manual reconciliation is required");
    }

    const postPaymentWarnings: string[] = [];
    for (const recipient of results) {
      const { error: activityError } = await supabase.from("activity_events").insert({
        issue_id: issueId,
        event_type: "PAYOUT_SENT",
        actor_username: recipient.githubUsername,
        amount: recipient.amount,
        tx_hash: recipient.result.txHash,
        metadata: { approved_by: params.approvedBy, payout_source: "web", split_payout: true },
      });
      if (activityError) {
        console.error("Split payout succeeded but activity logging failed:", activityError);
        postPaymentWarnings.push("Failed to persist payout activity for @" + recipient.githubUsername);
      }
    }

    try {
      await syncGithubBountyArtifacts(issueId);
    } catch (error) {
      console.error("Split payout succeeded but GitHub artifact sync failed:", error);
      postPaymentWarnings.push("Failed to sync GitHub bounty artifacts");
    }

    return {
      issueId,
      amount: bounty.total_amount,
      recipients: results.map((recipient) => ({
        githubUsername: recipient.githubUsername,
        amount: recipient.amount,
        payoutType: recipient.result.payoutType,
        recipientEmail: recipient.result.recipientEmail,
        txHash: recipient.result.txHash,
        transactionId: recipient.result.transactionId,
      })),
      approvedBy: params.approvedBy,
      warnings: postPaymentWarnings,
    };
  }

  // Backward-compatible single-winner payout.
  const payoutResult = await resolveAndPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: bounty.winning_pr_author,
    winningPrBody,
    amount: bounty.total_amount,
    issueId,
  });

  // An unclaimed payout does not transfer funds. Keep the bounty LOCKED so a
  // maintainer can retry after the winner connects a payout destination.
  if (payoutResult.payoutType === "unclaimed") {
    await syncGithubBountyArtifacts(issueId);
    return {
      issueId,
      amount: bounty.total_amount,
      recipient: bounty.winning_pr_author,
      payoutType: payoutResult.payoutType,
      recipientEmail: payoutResult.recipientEmail,
      recipientWallet: payoutResult.recipientWallet,
      txHash: payoutResult.txHash,
      transactionId: payoutResult.transactionId,
      approvedBy: params.approvedBy,
    };
  }

  const now = new Date().toISOString();

  const { data: paidBounty, error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: payoutResult.txHash,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId)
    .eq("status", "LOCKED")
    .select("issue_id")
    .maybeSingle();

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }
  if (!paidBounty) {
    throw new Error("Bounty state changed during payout; funds may have moved and manual reconciliation is required");
  }

  const postPaymentWarnings: string[] = [];
  const { error: payoutEventError } = await supabase.from("payout_events").insert({
    issue_id: issueId,
    recipient_username: bounty.winning_pr_author,
    amount: bounty.total_amount,
    locus_transaction_id: payoutResult.transactionId,
    transaction_hash: payoutResult.txHash,
    status: "SUCCESS",
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      payout_type: payoutResult.payoutType,
      recipient_email: payoutResult.recipientEmail,
      recipient_wallet: payoutResult.recipientWallet,
    },
  });

  if (payoutEventError) {
    console.error("Payout succeeded but payout event persistence failed:", payoutEventError);
    postPaymentWarnings.push("Failed to persist payout event");
  }

  const { error: activityError } = await supabase.from("activity_events").insert({
    issue_id: issueId,
    event_type: "PAYOUT_SENT",
    actor_username: bounty.winning_pr_author,
    amount: bounty.total_amount,
    tx_hash: payoutResult.txHash,
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      payout_type: payoutResult.payoutType,
    },
  });

  if (activityError) {
    console.error("Payout succeeded but activity logging failed:", activityError);
    postPaymentWarnings.push("Failed to persist payout activity");
  }

  try {
    await syncGithubBountyArtifacts(issueId);
  } catch (error) {
    console.error("Payout succeeded but GitHub artifact sync failed:", error);
    postPaymentWarnings.push("Failed to sync GitHub bounty artifacts");
  }

  return {
    issueId,
    amount: bounty.total_amount,
    recipient: bounty.winning_pr_author,
    payoutType: payoutResult.payoutType,
    recipientEmail: payoutResult.recipientEmail,
    recipientWallet: payoutResult.recipientWallet,
    txHash: payoutResult.txHash,
    transactionId: payoutResult.transactionId,
    approvedBy: params.approvedBy,
    warnings: postPaymentWarnings,
  };
}