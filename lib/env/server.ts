import "server-only";

import { z } from "zod";

const supabaseServerEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
});

const githubServerEnvSchema = z.object({
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
});

const locusServerEnvSchema = z
  .object({
    LOCUS_MOCK: z
      .enum(["true", "false"])
      .optional()
      .default("false")
      .transform((value) => value === "true"),
    LOCUS_API_KEY: z.string().min(1).optional(),
    LOCUS_API_BASE_URL: z.string().url().default("https://beta-api.paywithlocus.com/api"),
    LOCUS_WEBHOOK_SECRET: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.LOCUS_MOCK && !value.LOCUS_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "LOCUS_API_KEY is required when LOCUS_MOCK is false",
        path: ["LOCUS_API_KEY"],
      });
    }
  });

export type SupabaseServerEnv = z.infer<typeof supabaseServerEnvSchema>;
export type GithubServerEnv = z.infer<typeof githubServerEnvSchema>;
export type LocusServerEnv = z.infer<typeof locusServerEnvSchema>;

let cachedSupabaseServerEnv: SupabaseServerEnv | undefined;
let cachedGithubServerEnv: GithubServerEnv | undefined;
let cachedLocusServerEnv: LocusServerEnv | undefined;

export function isEnvironmentProduction() {
  return process.env.NODE_ENV === "production";
}

export function getSupabaseServerEnv(): SupabaseServerEnv {
  if (cachedSupabaseServerEnv) {
    return cachedSupabaseServerEnv;
  }

  cachedSupabaseServerEnv = supabaseServerEnvSchema.parse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  });

  return cachedSupabaseServerEnv;
}

export function getGithubServerEnv(): GithubServerEnv {
  if (cachedGithubServerEnv) {
    return cachedGithubServerEnv;
  }

  cachedGithubServerEnv = githubServerEnvSchema.parse({
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  });

  return cachedGithubServerEnv;
}

export function getLocusServerEnv(): LocusServerEnv {
  if (cachedLocusServerEnv) {
    return cachedLocusServerEnv;
  }

  cachedLocusServerEnv = locusServerEnvSchema.parse({
    LOCUS_MOCK: process.env.LOCUS_MOCK,
    LOCUS_API_KEY: process.env.LOCUS_API_KEY,
    LOCUS_API_BASE_URL: process.env.LOCUS_API_BASE_URL,
    LOCUS_WEBHOOK_SECRET: process.env.LOCUS_WEBHOOK_SECRET,
  });

  return cachedLocusServerEnv;
}
