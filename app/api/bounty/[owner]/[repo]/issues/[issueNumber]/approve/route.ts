import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getViewerRepoPermission } from "@/lib/auth/github-permissions";
import { approveBountyPayout } from "@/lib/bounty/services/approve-payout";

const approvalBodySchema = z.object({
  splitPayouts: z.array(
    z.object({
      githubUsername: z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i, "Invalid GitHub username"),
      amount: z.number().positive().refine(
        (amount) => Number.isSafeInteger(Math.round(amount * 100)) && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-8,
        "Payout amount must use whole cents",
      ),
    }).strict(),
  ).min(2).max(50).optional(),
});

const routeParamsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.coerce.number().int().positive(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string; issueNumber: string }> },
) {
  const resolvedParams = await params;
  const routeParams = routeParamsSchema.parse(resolvedParams);

  const viewer = await getViewerRepoPermission(routeParams.owner, routeParams.repo);

  if (!viewer.isAuthenticated) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  if (!viewer.canApprovePayment || !viewer.githubUsername) {
    return NextResponse.json({ error: "insufficient-permissions" }, { status: 403 });
  }

  try {
    const rawBody = await request.json().catch(() => ({}));
    const body = approvalBodySchema.parse(rawBody);
    const result = await approveBountyPayout({
      owner: routeParams.owner,
      repo: routeParams.repo,
      issueNumber: routeParams.issueNumber,
      approvedBy: viewer.githubUsername,
      splitPayouts: body.splitPayouts,
    });

    return NextResponse.json({ success: true, payout: result });
  } catch (error) {
    return NextResponse.json(
      {
        error: "approve-failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 400 },
    );
  }
}
