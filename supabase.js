import { createClient } from "@supabase/supabase-js";

// 1. Environment variables read karein
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Fallback error check
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in environment variables.");
}

// ---------------------------------------------------------------------------
// Client instance: Browser / Frontend / Public API ke liye (Row Level Security / RLS lagti hai)
// ---------------------------------------------------------------------------
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---------------------------------------------------------------------------
// Admin instance: Backend / API Routes / Webhooks ke liye (RLS bypass karta hai)
// Warning: Ise kabhi bhi frontend/browser code me import mat karein!
// ---------------------------------------------------------------------------
export const supabaseAdmin = supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

