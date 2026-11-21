import type { CSSProperties } from 'react';

/**
 * Compass dial: frosted disc, tick ring, red north marker, light "N".
 * The dial rotates by -bearing so the red marker always points north.
 */
export default function Compass({
  bearing,
  onClick,
  size = 46,
  background = 'rgba(255, 255, 255, 0.92)',
  style,
  className,
}: {
  bearing: number;
  onClick?: () => void;
  size?: number;
  background?: string;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <button
      className={className}
      aria-label="Face north"
      title="Face north"
      onClick={onClick}
      style={{
        width: size,
        height: size,
        padding: 0,
        border: 'none',
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        background,
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.1), 0 4px 16px rgba(0,0,0,0.12)',
        cursor: 'pointer',
        ...style,
      }}
    >
      <svg width={size} height={size} viewBox="0 0 46 46" style={{ display: 'block', transform: `rotate(${-bearing}deg)`, transition: 'transform 0.12s linear' }}>
        {Array.from({ length: 12 }, (_, i) => {
          if (i === 0) return null; // north is the red marker
          const a = (i * 30 * Math.PI) / 180;
          const major = i % 3 === 0;
          const r1 = major ? 15.2 : 16.4, r2 = 19;
          return (
            <line
              key={i}
              x1={23 + Math.sin(a) * r1}
              y1={23 - Math.cos(a) * r1}
              x2={23 + Math.sin(a) * r2}
              y2={23 - Math.cos(a) * r2}
              stroke={major ? '#8e8e93' : '#b9b9be'}
              strokeWidth={major ? 1.5 : 1.2}
              strokeLinecap="round"
            />
          );
        })}
        <path d="M23 2.6 L26.6 8.6 L19.4 8.6 Z" fill="#ff3b30" />
        <text x="23" y="28.6" textAnchor="middle" fontSize="15" fontWeight="400" fill="#636366" fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif">
          N
        </text>
      </svg>
    </button>
  );
}
