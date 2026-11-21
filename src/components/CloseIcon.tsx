/** A longer-stroke close mark shared by the map panel and panorama. */
export default function CloseIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  );
}
