import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Desktop city picker (Apple Maps Guides style): continents; hovering a continent
 * opens a side panel with its cities (name + grey country line). Rendered in a portal at the
 * page root so it can extend past the side panel over the map.
 */
export type CityOption = { city: string; name: string; sub: string; continent: string };

const chevron = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
);

export default function CityMenu({
  anchor,
  container,
  options,
  current,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  container: HTMLElement;
  options: CityOption[];
  current: string;
  onPick: (city: string) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const continents = [...new Set(options.map(o => o.continent))];
  const currentContinent = options.find(o => o.city === current)?.continent ?? null;
  const [open, setOpen] = useState<string | null>(null);
  const [subTop, setSubTop] = useState(0);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  // place under the anchor (coordinates relative to the page-root container)
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect(), c = container.getBoundingClientRect();
    setPos({ left: a.left - c.left, top: a.bottom - c.top + 8 });
  }, [anchor, container]);

  // close on outside click / Escape
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || sub.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [anchor, onClose]);

  const openContinent = (name: string, row: HTMLElement) => {
    setOpen(name);
    // side panel starts level with the hovered row (kept on screen)
    const m = menu.current!.getBoundingClientRect(), r = row.getBoundingClientRect();
    setSubTop(Math.max(0, r.top - m.top - 8));
  };

  const cities = open ? options.filter(o => o.continent === open) : [];

  return createPortal(
    <div className="ex-cmenu-layer" style={{ left: pos.left, top: pos.top }}>
      <div ref={menu} className="ex-cmenu" role="menu">
        {continents.map(name => (
          <button
            key={name}
            className={`ex-cmenu__row ${open === name ? 'is-open' : ''} ${currentContinent === name ? 'is-current' : ''}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === name}
            onMouseEnter={e => openContinent(name, e.currentTarget)}
            onClick={e => openContinent(name, e.currentTarget)}
          >
            <span className="ex-cmenu__name">{name}</span>
            {chevron}
          </button>
        ))}
      </div>
      {open && (
        <div ref={sub} className="ex-cmenu ex-cmenu--sub" role="menu" aria-label={open} style={{ top: subTop }}>
          {cities.map(o => (
            <button key={o.city} className={`ex-cmenu__row ex-cmenu__row--city ${o.city === current ? 'is-current' : ''}`} role="menuitem" onClick={() => onPick(o.city)}>
              <span className="ex-cmenu__name">{o.name}</span>
              {o.sub && <span className="ex-cmenu__sub">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>,
    container,
  );
}
