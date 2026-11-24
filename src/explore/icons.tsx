export function SearchIcon({ size = 20, weight = 1.9 }: { size?: number; weight?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M20 20l-4.6-4.6" /></svg>;
}

/** Big empty-state magnifier drawn like SF Symbols' magnifyingglass: a solid ring and a
 *  shorter, heavier rounded handle (a thin outline scaled up looks like a wireframe). */
export function EmptySearchGlyph() {
  return (
    <svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
      <circle cx="23" cy="23" r="14.5" strokeWidth="4.6" />
      <path d="M34 34l10.5 10.5" strokeWidth="6.4" />
    </svg>
  );
}

interface ChevronProps { size: number; weight: number; d: string }
function Chevron({ size, weight, d }: ChevronProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}
export const ChevronRight = () => <Chevron size={14} weight={2.8} d="M9 6l6 6-6 6" />;
export const ChevronDown = () => <Chevron size={13} weight={2.6} d="M6 9l6 6 6-6" />;

export function ClearIcon() {
  return (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="10" fill="currentColor" />
        <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
  );
}

export function ExploreIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2.2" /><rect x="13" y="3.5" width="7.5" height="7.5" rx="2.2" /><rect x="3.5" y="13" width="7.5" height="7.5" rx="2.2" /><rect x="13" y="13" width="7.5" height="7.5" rx="2.2" /></svg>;
}
