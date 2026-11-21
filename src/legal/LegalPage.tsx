import { useEffect, type ReactNode } from 'react';

/** Shared layout for the privacy policy and terms: plain, readable, scrolls like a normal page. */
export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  useEffect(() => {
    // the app locks scrolling for the map/viewer; legal pages scroll normally
    const root = document.getElementById('root')!;
    const targets = [document.body, document.documentElement, root];
    for (const el of targets) { el.style.overflow = 'auto'; el.style.height = 'auto'; }
    root.style.position = 'static';
    return () => {
      for (const el of targets) { el.style.overflow = ''; el.style.height = ''; }
      root.style.position = '';
    };
  }, []);
  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#1c1c1e', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <article style={{ maxWidth: 600, margin: '0 auto', padding: '48px 24px 64px', fontSize: 15, lineHeight: 1.6 }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 28, fontWeight: 700 }}>{title}</h1>
        <p style={{ margin: '0 0 28px', color: '#8e8e93', fontSize: 14 }}>Last updated {updated}</p>
        {children}
      </article>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 600 }}>{heading}</h2>
      {children}
    </section>
  );
}
