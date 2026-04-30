"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const statusOptions = [
  { value: "all", label: "All Status" },
  { value: "OPEN", label: "Open" },
  { value: "LOCKED", label: "Locked" },
  { value: "PAID", label: "Paid" },
];

const sortOptions = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "amount_desc", label: "Highest Amount" },
  { value: "amount_asc", label: "Lowest Amount" },
];

export function FilterBar() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentStatus = searchParams.get("status") || "all";
  const currentSort = searchParams.get("sort") || "newest";

  const updateParams = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      const trimmedValue = value.trim();
      if (trimmedValue === "" || (key === "status" && trimmedValue === "all") || (key === "sort" && trimmedValue === "newest")) {
        params.delete(key);
      } else {
        params.set(key, trimmedValue);
      }
      router.push(`/explore?${params.toString()}`);
    },
    [router, searchParams]
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={currentStatus as string} onValueChange={(v) => v && updateParams("status", v)}>
        <SelectTrigger className="h-10 w-[170px] border-zinc-700 bg-zinc-950 text-zinc-300">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent className="bg-zinc-900 border-zinc-800">
          {statusOptions.map((opt) => (
            <SelectItem
              key={opt.value}
              value={opt.value}
              className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100"
            >
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={currentSort as string} onValueChange={(v) => v && updateParams("sort", v)}>
        <SelectTrigger className="h-10 w-[200px] border-zinc-700 bg-zinc-950 text-zinc-300">
          <SelectValue placeholder="Sort" />
        </SelectTrigger>
        <SelectContent className="bg-zinc-900 border-zinc-800">
          {sortOptions.map((opt) => (
            <SelectItem
              key={opt.value}
              value={opt.value}
              className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100"
            >
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant="ghost"
        size="default"
        onClick={() => router.push("/explore")}
        className="h-10 border border-zinc-700 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
      >
        Clear filters
      </Button>
    </div>
  );
}
