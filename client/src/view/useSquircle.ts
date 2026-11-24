import { useEffect, type RefObject } from 'react';

/**
 * Attempt to generate a true superellipse (squircle) clip-path.
 * Each corner uses points on |x|^n + |y|^n = r^n (n=5 for iOS-style).
 * Straight edges connect the corners.
 */
function generateSquirclePath(
  w: number,
  h: number,
  cornerRadius: number,
  n: number = 2.5,
): string {
  const r = Math.min(cornerRadius, w / 2, h / 2);
  const e = 2 / n; // exponent for superellipse
  const steps = 16; // points per corner quarter

  const pts: string[] = [];

  // Start after top-left corner on the top edge
  pts.push(`M ${r},0`);

  // Top edge
  pts.push(`L ${w - r},0`);

  // Top-right corner: center (w-r, r), sweep from top to right
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI / 2) * (1 - i / steps);
    const x = (w - r) + r * Math.pow(Math.cos(t), e);
    const y = r - r * Math.pow(Math.sin(t), e);
    pts.push(`L ${x.toFixed(2)},${y.toFixed(2)}`);
  }

  // Right edge
  pts.push(`L ${w},${h - r}`);

  // Bottom-right corner: center (w-r, h-r), sweep from right to bottom
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI / 2) * (i / steps);
    const x = (w - r) + r * Math.pow(Math.cos(t), e);
    const y = (h - r) + r * Math.pow(Math.sin(t), e);
    pts.push(`L ${x.toFixed(2)},${y.toFixed(2)}`);
  }

  // Bottom edge
  pts.push(`L ${r},${h}`);

  // Bottom-left corner: center (r, h-r), sweep from bottom to left
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI / 2) * (1 - i / steps);
    const x = r - r * Math.pow(Math.cos(t), e);
    const y = (h - r) + r * Math.pow(Math.sin(t), e);
    pts.push(`L ${x.toFixed(2)},${y.toFixed(2)}`);
  }

  // Left edge
  pts.push(`L 0,${r}`);

  // Top-left corner: center (r, r), sweep from left to top
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI / 2) * (i / steps);
    const x = r - r * Math.pow(Math.cos(t), e);
    const y = r - r * Math.pow(Math.sin(t), e);
    pts.push(`L ${x.toFixed(2)},${y.toFixed(2)}`);
  }

  pts.push('Z');
  return pts.join(' ');
}

export function useSquircle(
  ref: RefObject<HTMLElement | null>,
  radius: number = 32,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Clear border-radius and overflow so they don't fight the clip-path
    const prevBorderRadius = el.style.borderRadius;
    const prevOverflow = el.style.overflow;
    el.style.borderRadius = '0';
    el.style.overflow = 'visible';

    const update = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (width > 0 && height > 0) {
        const path = generateSquirclePath(width, height, radius);
        el.style.clipPath = `path('${path}')`;
      }
    };

    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();

    return () => {
      observer.disconnect();
      el.style.borderRadius = prevBorderRadius;
      el.style.overflow = prevOverflow;
      el.style.clipPath = '';
    };
  }, [ref, radius]);
}
