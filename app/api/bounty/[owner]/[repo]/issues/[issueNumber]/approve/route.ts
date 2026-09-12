import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getViewerRepoPermission } from "@/lib/auth/github-permissions";
import { approveBountyPayout } from "@/lib/bounty/services/approve-payout";

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
    // Empty requests retain the existing single-author approval behavior.
    const rawBody = await request.text();
    const body = z.object({
      shares: z.array(z.object({
        username: z.string(),
        basisPoints: z.number().int().positive().max(10000),
      }).strict()).min(1).max(50).optional(),
    }).strict().parse(rawBody.trim() ? JSON.parse(rawBody) : {});
    const result = await approveBountyPayout({
      owner: routeParams.owner,
      repo: routeParams.repo,
      issueNumber: routeParams.issueNumber,
      approvedBy: viewer.githubUsername,
      shares: body.shares,
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
