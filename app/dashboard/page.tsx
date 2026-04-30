"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TrendingUp, Wallet, ArrowUpRight, ArrowDownRight, ArrowUp, ArrowDown, type LucideIcon } from "lucide-react";

import { fetchMe, type DashboardData } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatAmount, formatDateTime, getStatusColor } from "@/components/bounty/utils";

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <div className="animate-pulse">
        <div className="h-8 w-48 rounded bg-zinc-800"></div>
        <div className="mt-4 h-4 w-64 rounded bg-zinc-800"></div>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-2xl bg-zinc-900"></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  subValue,
  color,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  subValue?: string;
  color: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/60 p-5">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-zinc-100">{value}</p>
          {subValue && <p className="text-xs text-zinc-500">{subValue}</p>}
        </div>
      </div>
    </div>
  );
}

function BountyRow({
  bounty,
  type,
}: {
  bounty: {
    issue_id: string;
    owner: string;
    repo: string;
    issue_number: number;
    issue_title: string | null;
    issue_url: string | null;
    status: "OPEN" | "LOCKED" | "PAID";
    total_amount: number;
    my_funding?: number;
    funded_at?: string;
    paid_at?: string | null;
    tx_hash?: string | null;
  };
  type: "funded" | "won";
}) {
  const href = `/b/${bounty.owner}/${bounty.repo}/issues/${bounty.issue_number}`;

  return (
    <Link href={href}>
      <div className="group flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4 transition-all hover:border-emerald-400/30 hover:bg-zinc-900/60">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={getStatusColor(bounty.status)}>
              {bounty.status}
            </Badge>
            <span className="font-mono text-xs text-zinc-500">
              {bounty.owner}/{bounty.repo}#{bounty.issue_number}
            </span>
          </div>
          <p className="mt-2 truncate font-medium text-zinc-200 group-hover:text-emerald-300">
            {bounty.issue_title || `Issue #${bounty.issue_number}`}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {type === "funded" ? `You contributed` : `Won`} · {formatDateTime(type === "funded" ? (bounty.funded_at ?? "") : (bounty.paid_at ?? ""))}
          </p>
        </div>
        <div className="ml-4 text-right">
          {type === "funded" ? (
            <>
              <p className="font-mono text-lg font-semibold text-emerald-300">
                ${formatAmount(bounty.my_funding ?? 0)}
              </p>
              <p className="text-xs text-zinc-500">of ${formatAmount(bounty.total_amount)}</p>
            </>
          ) : (
            <p className="font-mono text-lg font-semibold text-emerald-300">
              ${formatAmount(bounty.total_amount)}
            </p>
          )}
        </div>
        <ArrowUpRight className="ml-3 h-4 w-4 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const handleSort = () => {
    setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
  };

  useEffect(() => {
    fetchMe()
      .then(setData)
      .catch((e) => {
        if (e instanceof Error && e.message.includes("auth-required")) {
          router.push("/connect?next=/dashboard");
          return;
        }
        setError(e instanceof Error ? e.message : "Failed to load dashboard");
      })
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) {
    return <DashboardSkeleton />;
  }

  if (error || !data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-zinc-400">Failed to load dashboard</p>
          <p className="mt-2 text-sm text-zinc-500">{error}</p>
          <Button onClick={() => router.refresh()} className="mt-4">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const { user, funded_bounties, stats } = data;

  const sortedWonBounties = [...data.won_bounties].sort((a, b) => {
    if (sortOrder === "asc") {
      return a.total_amount - b.total_amount;
    } else {
      return b.total_amount - a.total_amount;
    }
  });

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <div className="mb-8">
        <p className="text-xs uppercase tracking-[0.32em] text-emerald-300/80">Dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold text-zinc-100">Welcome back{user.github_username ? `, @${user.github_username}` : ""}</h1>
        <p className="mt-1 text-sm text-zinc-400">{user.email}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={TrendingUp}
          label="Total Funded"
          value={`$${formatAmount(stats.total_funded)}`}
          subValue={`${stats.funded_count} bounties`}
          color="bg-emerald-400/20 text-emerald-300"
        />
        <StatCard
          icon={Wallet}
          label="Total Won"
          value={`$${formatAmount(stats.total_won)}`}
          subValue={`${stats.won_count} bounties`}
          color="bg-yellow-400/20 text-yellow-300"
        />
        {/* who tf wants NET? */}
        {/* <StatCard
          icon={stats.total_won > stats.total_funded ? ArrowUpRight : ArrowDownRight}
          label="Net"
          value={stats.total_won >= stats.total_funded ? `+$${formatAmount(stats.total_won - stats.total_funded)}` : `-$${formatAmount(stats.total_funded - stats.total_won)}`}
          subValue={stats.total_won >= stats.total_funded ? " earnings" : " spent"}
          color={stats.total_won >= stats.total_funded ? "bg-blue-400/20 text-blue-300" : "bg-red-400/20 text-red-300"}
        /> */}
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">Bounties You Funded</h2>
          </div>
          <div className="mt-4 space-y-3">
            {funded_bounties.length === 0 ? (
              <div className="rounded-xl min-h-28 border border-zinc-800/60 bg-zinc-900/40 p-8 text-center">
                <p className="text-zinc-400">You haven&apos;t funded any bounties yet</p>
              </div>
            ) : (
              funded_bounties.slice(0, 5).map((bounty) => (
                <BountyRow key={bounty.issue_id} bounty={bounty} type="funded" />
              ))
            )}
            {funded_bounties.length > 5 && (
              <p className="text-center text-sm text-zinc-500">
                +{funded_bounties.length - 5} more
              </p>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">Bounties You Won</h2>
            <Button variant="ghost" size="sm" onClick={handleSort}>
              Amount
              {sortOrder === "asc" ? <ArrowUp className="ml-2 h-4 w-4" /> : <ArrowDown className="ml-2 h-4 w-4" />}
            </Button>
          </div>
          <div className="mt-4 space-y-3">
            {won_bounties.length === 0 ? (
              <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-8 text-center">
                <p className="text-zinc-400">You haven&apos;t won any bounties yet</p>
                <p className="mt-1 text-sm text-zinc-500">Submit a PR to start earning!</p>
              </div>
            ) : (
              sortedWonBounties.slice(0, 5).map((bounty) => (
                <BountyRow key={bounty.issue_id} bounty={bounty} type="won" />
              ))
            )}
            {won_bounties.length > 5 && (
              <p className="text-center text-sm text-zinc-500">
                +{won_bounties.length - 5} more
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}