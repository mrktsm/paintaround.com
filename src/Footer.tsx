export default function Footer() {


    return (
        <div
            style={{
                position: 'fixed',
                bottom: '24px',
                right: '24px',
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                fontSize: '11px',
                color: 'rgba(255, 255, 255, 0.4)',
                zIndex: 9999,
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                pointerEvents: 'auto',
                padding: '2px 8px',
            }}
        >
            <a href="https://github.com/sponsors/mrktsm" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none', transition: 'color 0.2s', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }} onMouseEnter={e => e.currentTarget.style.color = 'rgba(255,255,255,0.8)'} onMouseLeave={e => e.currentTarget.style.color = 'inherit'}>
                Support this project
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
            </a>
        </div>
    );
}
