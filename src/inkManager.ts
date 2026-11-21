import { supabase } from './supabaseClient';

const DEVICE_ID_KEY = 'streetview_device_id';
const INK_REGEN_RATE_PER_MS = 0.00023 / 16.6; // Convert frame-rate regen to ms-based

function getOrCreateDeviceId(): string {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        // crypto.randomUUID only exists on secure (HTTPS/localhost) pages — fall back so the app
        // never crashes on plain HTTP
        id = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
                (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
        localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
}

export const deviceId = getOrCreateDeviceId();

/**
 * Fetch the current ink level from Supabase, calculating regen based on elapsed time.
 * Creates a new row if the device hasn't been seen before.
 * Pass userId to tie ink to an account instead of the device.
 */
export async function fetchInkLevel(userId?: string, maxInk: number = 100): Promise<number> {
    const id = userId || deviceId;
    const { data, error } = await supabase
        .from('ink_levels')
        .select('ink_level, last_updated_at')
        .eq('device_id', id)
        .single();

    if (error || !data) {
        // New device/user — create entry with full ink
        await supabase.from('ink_levels').insert({
            device_id: id,
            ink_level: maxInk,
            last_updated_at: new Date().toISOString(),
        });
        return maxInk;
    }

    // Calculate regen based on elapsed time
    const lastTime = new Date(data.last_updated_at).getTime();
    const elapsed = Date.now() - lastTime;
    const regenAmount = elapsed * INK_REGEN_RATE_PER_MS;
    const newLevel = Math.min(data.ink_level + regenAmount, maxInk);

    return newLevel;
}

/**
 * Save the current ink level to Supabase.
 * Debounce this — don't call on every pixel.
 * Pass userId to tie ink to an account instead of the device.
 */
export async function saveInkLevel(level: number, userId?: string): Promise<void> {
    const id = userId || deviceId;
    await supabase
        .from('ink_levels')
        .upsert({
            device_id: id,
            ink_level: level,
            last_updated_at: new Date().toISOString(),
        });
}
