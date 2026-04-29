export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          email: string;
          github_username: string;
          locus_wallet_address: string | null;
          created_at: string;
        };
        Insert: {
          email: string;
          github_username: string;
          locus_wallet_address?: string | null;
          created_at?: string;
        };
        Update: {
          email?: string;
          github_username?: string;
          locus_wallet_address?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      bounties: {
        Row: {
          issue_id: string;
          status: Database["public"]["Enums"]["bounty_status"];
          total_amount: number;
          issue_title: string | null;
          issue_body: string | null;
          issue_state: string | null;
          issue_url: string | null;
          ledger_comment_id: string | null;
          funded_by_agent: boolean;
          payout_tx_hash: string | null;
          winning_pr_number: number | null;
          winning_pr_author: string | null;
          winning_pr_url: string | null;
          winning_pr_coauthors: Json | null;
          locked_at: string | null;
          paid_at: string | null;
          approved_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          issue_id: string;
          status?: Database["public"]["Enums"]["bounty_status"];
          total_amount?: number;
          issue_title?: string | null;
          issue_body?: string | null;
          issue_state?: string | null;
          issue_url?: string | null;
          ledger_comment_id?: string | null;
          funded_by_agent?: boolean;
          payout_tx_hash?: string | null;
          winning_pr_number?: number | null;
          winning_pr_author?: string | null;
          winning_pr_url?: string | null;
          winning_pr_coauthors?: Json | null;
          locked_at?: string | null;
          paid_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          issue_id?: string;
          status?: Database["public"]["Enums"]["bounty_status"];
          total_amount?: number;
          issue_title?: string | null;
          issue_body?: string | null;
          issue_state?: string | null;
          issue_url?: string | null;
          ledger_comment_id?: string | null;
          funded_by_agent?: boolean;
          payout_tx_hash?: string | null;
          winning_pr_number?: number | null;
          winning_pr_author?: string | null;
          winning_pr_url?: string | null;
          winning_pr_coauthors?: Json | null;
          locked_at?: string | null;
          paid_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      funding_events: {
        Row: {
          id: string;
          issue_id: string;
          funder_username: string | null;
          funder_display_name: string | null;
          funder_email: string | null;
          amount: number;
          funding_source: Database["public"]["Enums"]["funding_source"];
          locus_checkout_id: string;
          locus_webhook_secret: string | null;
          payment_status: Database["public"]["Enums"]["funding_payment_status"];
          created_at: string;
        };
        Insert: {
          id?: string;
          issue_id: string;
          funder_username?: string | null;
          funder_display_name?: string | null;
          funder_email?: string | null;
          amount: number;
          funding_source?: Database["public"]["Enums"]["funding_source"];
          locus_checkout_id: string;
          locus_webhook_secret?: string | null;
          payment_status?: Database["public"]["Enums"]["funding_payment_status"];
          created_at?: string;
        };
        Update: {
          id?: string;
          issue_id?: string;
          funder_username?: string | null;
          funder_display_name?: string | null;
          funder_email?: string | null;
          amount?: number;
          funding_source?: Database["public"]["Enums"]["funding_source"];
          locus_checkout_id?: string;
          locus_webhook_secret?: string | null;
          payment_status?: Database["public"]["Enums"]["funding_payment_status"];
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "funding_events_issue_id_fkey";
            columns: ["issue_id"];
            isOneToOne: false;
            referencedRelation: "bounties";
            referencedColumns: ["issue_id"];
          },
        ];
      };
      activity_events: {
        Row: {
          id: string;
          issue_id: string;
          event_type: Database["public"]["Enums"]["activity_event_type"];
          actor_username: string | null;
          amount: number | null;
          funding_event_id: string | null;
          pr_number: number | null;
          pr_url: string | null;
          tx_hash: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          issue_id: string;
          event_type: Database["public"]["Enums"]["activity_event_type"];
          actor_username?: string | null;
          amount?: number | null;
          funding_event_id?: string | null;
          pr_number?: number | null;
          pr_url?: string | null;
          tx_hash?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          issue_id?: string;
          event_type?: Database["public"]["Enums"]["activity_event_type"];
          actor_username?: string | null;
          amount?: number | null;
          funding_event_id?: string | null;
          pr_number?: number | null;
          pr_url?: string | null;
          tx_hash?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "activity_events_funding_event_id_fkey";
            columns: ["funding_event_id"];
            isOneToOne: false;
            referencedRelation: "funding_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "activity_events_issue_id_fkey";
            columns: ["issue_id"];
            isOneToOne: false;
            referencedRelation: "bounties";
            referencedColumns: ["issue_id"];
          },
        ];
      };
      payout_events: {
        Row: {
          id: string;
          issue_id: string;
          recipient_username: string;
          amount: number;
          locus_transaction_id: string | null;
          transaction_hash: string | null;
          status: Database["public"]["Enums"]["payout_status"];
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          issue_id: string;
          recipient_username: string;
          amount: number;
          locus_transaction_id?: string | null;
          transaction_hash?: string | null;
          status?: Database["public"]["Enums"]["payout_status"];
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          issue_id?: string;
          recipient_username?: string;
          amount?: number;
          locus_transaction_id?: string | null;
          transaction_hash?: string | null;
          status?: Database["public"]["Enums"]["payout_status"];
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "payout_events_issue_id_fkey";
            columns: ["issue_id"];
            isOneToOne: false;
            referencedRelation: "bounties";
            referencedColumns: ["issue_id"];
          },
        ];
      };
      webhook_deliveries: {
        Row: {
          id: string;
          delivery_id: string;
          source: string;
          processed_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          delivery_id: string;
          source: string;
          processed_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          delivery_id?: string;
          source?: string;
          processed_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      bounty_status: "OPEN" | "LOCKED" | "PAID";
      funding_payment_status: "PENDING" | "SUCCESS";
      funding_source: "WEB" | "API";
      activity_event_type:
        | "FUNDING_ADDED"
        | "PR_COMPETING"
        | "BOUNTY_LOCKED"
        | "PAYOUT_SENT"
        | "BOUNTY_CREATED";
      payout_status: "PENDING" | "SUCCESS" | "FAILED";
    };
    CompositeTypes: Record<string, never>;
  };
};
