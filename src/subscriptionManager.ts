import { supabase } from './supabaseClient';

export type PlusTier = { isPlus: boolean; maxInk: number; regenMultiplier: number };
// All tools unlocked for everyone: every tier reports isPlus: true.

export const GUEST_TIER: PlusTier = { isPlus: true, maxInk: 30, regenMultiplier: 1 };
const FREE_TIER: PlusTier = { isPlus: true, maxInk: 150, regenMultiplier: 1 };
const PLUS_TIER: PlusTier = { isPlus: true, maxInk: 300, regenMultiplier: 2 };

// No accounts: everyone gets what signed-in users used to (150 ink).
export const DEFAULT_TIER = FREE_TIER;

export async function fetchSubscriptionTier(userId: string): Promise<PlusTier> {
  const { data } = await supabase
    .from('subscriptions')
    .select('status, current_period_end')
    .eq('user_id', userId)
    .single();

  if (!data || data.status !== 'active') return FREE_TIER;

  // Gift codes have an expiry date; one-time purchases don't
  if (data.current_period_end && new Date(data.current_period_end) < new Date()) {
    return FREE_TIER;
  }

  return PLUS_TIER;
}

export async function createCheckoutSession(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL || 'https://example.supabase.co'}/functions/v1/create-checkout-session`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ origin: window.location.origin }),
    }
  );
  const { url } = await res.json();
  return url;
}
