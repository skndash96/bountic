import { resolveAndPayout, PayoutResult } from "./payout";
import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";

// Mock dependencies
jest.mock("@/lib/clients/locus/server");
jest.mock("@/lib/clients/supabase/server");
jest.mock("@/lib/clients/github/server", () => ({
  getGithubInstallationClient: jest.fn(),
  getGithubRepoInstallationId: jest.fn(),
}));

describe("Multi-recipient Payout Logic", () => {
  const mockLocus = {
    request: jest.fn(),
  };

  const mockSupabase = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getLocusServerClient as jest.Mock).mockReturnValue(mockLocus);
    (getSupabaseServiceClient as jest.Mock).mockReturnValue(mockSupabase);
  });

  test("should distribute payout evenly with remainder to the last person", async () => {
    mockSupabase.maybeSingle.mockResolvedValue({ data: { email: "test@example.com" } });
    mockLocus.request.mockResolvedValue({ transaction_id: "tx123" });

    const results = await resolveAndPayout({
      owner: "owner",
      repo: "repo",
      issueNumber: 1,
      winningPrAuthor: "alice",
      winningPrBody: "<!-- bountic-split: @a:1, @b:1, @c:1 -->",
      amount: 10.00,
      issueId: "owner/repo#1",
    });

    expect(results).toHaveLength(3);
    expect(results[0].amount).toBe(3.33);
    expect(results[1].amount).toBe(3.33);
    expect(results[2].amount).toBe(3.34);
    expect(results.every(r => r.status === "SUCCESS")).toBe(true);
  });

  test("should handle individual failures and record FAILED status (Double-Spend prevention)", async () => {
    mockSupabase.maybeSingle.mockResolvedValue({ data: { email: "test@example.com" } });
    
    // First call succeeds, second fails
    mockLocus.request
      .mockResolvedValueOnce({ transaction_id: "tx1" })
      .mockRejectedValueOnce(new Error("API Timeout"))
      .mockResolvedValueOnce({ transaction_id: "tx3" });

    const results = await resolveAndPayout({
      owner: "owner",
      repo: "repo",
      issueNumber: 1,
      winningPrAuthor: "alice",
      winningPrBody: "<!-- bountic-split: @a:50, @b:50 -->",
      amount: 100.00,
      issueId: "owner/repo#1",
    });

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("SUCCESS");
    expect(results[1].status).toBe("FAILED");
    expect(results[1].transactionId).toBeNull();
  });
});
