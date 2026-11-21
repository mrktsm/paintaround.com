import { useEffect, type ReactNode } from 'react';
import './legal.css';

/** Shared layout for the privacy policy and terms: a big title, the date, then numbered sections. */
export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  useEffect(() => {
    // The app locks the page for the map/viewer (#root is a fixed, overflow-hidden box and the
    // body has overscroll-behavior: none). Legal pages scroll like a normal document: only the
    // root element scrolls — making body/#root scroll boxes too stopped wheel scrolling dead,
    // because overscroll-behavior: none on body keeps the wheel from chaining up to the page.
    const html = document.documentElement;
    const prev = document.title;
    document.title = `${title} · paintaround`;
    html.classList.add('legal-doc');
    return () => {
      html.classList.remove('legal-doc');
      document.title = prev;
    };
  }, [title]);
  return (
    <div className="legal">
      <article className="legal-page">
        <h1>{title}</h1>
        <p className="legal-date">{updated}</p>
        {children}
        <footer className="legal-foot">
          <a href="/">paintaround</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
        </footer>
      </article>
    </div>
  );
}

export function Section({ n, heading, children }: { n: number; heading: string; children: ReactNode }) {
  return (
    <section>
      <h2>{n}. {heading}</h2>
      {children}
    </section>
  );
}
