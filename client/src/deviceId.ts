const DEVICE_ID_KEY = 'streetview_device_id';

/** A random id this browser keeps; only used to pick your cursor colour. */
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
