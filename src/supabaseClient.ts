import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://example.supabase.co';
const SUPABASE_ANON_KEY = 'REMOVED';

const realClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * LOCAL MODE (on everywhere for now — dev and production):
 * every table / storage / realtime / rpc call becomes a no-op that resolves to
 * `{ data: null, error: null }`. Nobody else's strokes load, nothing you draw is
 * saved, ink stays full. Auth still uses the real client.
 * Existing drawings stay untouched in the database.
 * Build/run with VITE_LIVE_DB=1 to talk to the real database again.
 */
export const LOCAL_MODE = import.meta.env.VITE_LIVE_DB !== '1';

function noop(): unknown {
  const result = { data: null, error: null, count: 0, status: 200 };
  const fn = () => {};
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      if (prop === 'catch' || prop === 'finally') return () => Promise.resolve(result);
      if (prop === 'data' || prop === 'error') return null;
      return noop();
    },
    apply() {
      return noop();
    },
  });
}

export const supabase: typeof realClient = LOCAL_MODE
  ? new Proxy(realClient, {
      get(target, prop, receiver) {
        if (prop === 'auth') return target.auth;
        if (prop === 'from' || prop === 'storage' || prop === 'channel' || prop === 'rpc' || prop === 'functions' || prop === 'removeChannel') {
          return noop();
        }
        return Reflect.get(target, prop, receiver);
      },
    })
  : realClient;

if (LOCAL_MODE) console.warn('[supabase] LOCAL MODE — strokes are not loaded or saved. Set VITE_LIVE_DB=1 to disable.');
