import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "./supabaseClient";
import Heatmap from "./Heatmap";

type RedeemState = "loading" | "ready" | "claiming" | "claimed" | "already_claimed" | "invalid" | "need_login";

const isDesktop = typeof window !== 'undefined' && window.innerWidth > 600;

export default function GiftRedeem() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<RedeemState>("loading");
  const [closing, setClosing] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  // Check auth + validate code on mount
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const uid = session?.user?.id ?? null;
      setUserId(uid);

      if (!code) { setState("invalid"); return; }

      const { data, error } = await supabase
        .from("gift_codes")
        .select("redeemed_by")
        .eq("code", code)
        .single();

      if (error || !data) { setState("invalid"); return; }
      if (data.redeemed_by) { setState("already_claimed"); return; }
      if (!uid) { setState("need_login"); return; }

      setState("ready");
    })();
  }, [code]);

  // Listen for auth changes (user signs in after seeing need_login)
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user?.id) {
        setUserId(session.user.id);
        if (code) {
          const { data } = await supabase
            .from("gift_codes")
            .select("redeemed_by")
            .eq("code", code)
            .single();
          if (data && !data.redeemed_by) setState("ready");
        }
      }
    });
    return () => subscription.unsubscribe();
  }, [code]);

  const handleClaim = async () => {
    if (!userId || !code) return;
    setState("claiming");

    const { error: giftError } = await supabase
      .from("gift_codes")
      .update({ redeemed_by: userId, redeemed_at: new Date().toISOString() })
      .eq("code", code)
      .is("redeemed_by", null);

    if (giftError) { setState("already_claimed"); return; }

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1);

    const { error: subError } = await supabase
      .from("subscriptions")
      .upsert({
        user_id: userId,
        status: "active",
        current_period_end: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

    if (subError) {
      console.error("Failed to activate subscription:", subError);
    }

    setState("claimed");
  };

  const handleSignIn = async () => {
    sessionStorage.setItem("giftRedirectCode", code || "");
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
  };

  const handleClose = () => {
    setClosing(true);
    setTimeout(() => navigate("/"), 300);
  };

  const subtitle = (() => {
    switch (state) {
      case "loading": return "Checking your gift...";
      case "ready":
      case "claiming": return "You've been gifted 1 month of Plus! Claim it below.";
      case "claimed": return "You now have 1 month of Plus! Enjoy.";
      case "already_claimed": return "This gift has already been claimed.";
      case "invalid": return "This gift link is invalid or expired.";
      case "need_login": return "Sign in to claim your gift of Plus.";
    }
  })();

  const buttonText = (() => {
    switch (state) {
      case "ready": return "Claim!";
      case "claiming": return "Claiming...";
      case "claimed": return "Start drawing";
      case "need_login": return "Sign in with Google";
      default: return "Go to map";
    }
  })();

  const buttonAction = (() => {
    switch (state) {
      case "ready": return handleClaim;
      case "claiming": return undefined;
      case "claimed": return handleClose;
      case "need_login": return handleSignIn;
      default: return handleClose;
    }
  })();

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0 }}>
      <Heatmap />

      <div style={{ position: "fixed", inset: 0, zIndex: 9999, pointerEvents: isDesktop ? 'none' : undefined }}>
        {/* Scrim — mobile only */}
        {!isDesktop && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.4)",
              animation: closing ? "sidebarScrimOut 0.3s forwards" : "sidebarScrimIn 0.3s forwards",
            }}
            onClick={handleClose}
          />
        )}

        {/* Sheet */}
        <div
          style={{
            position: isDesktop ? "fixed" : "absolute",
            bottom: 0,
            left: isDesktop ? '12px' : 0,
            right: isDesktop ? undefined : 0,
            width: isDesktop ? '360px' : undefined,
            maxWidth: isDesktop ? undefined : '420px',
            height: isDesktop ? '90vh' : undefined,
            marginLeft: isDesktop ? undefined : 'auto',
            marginRight: isDesktop ? undefined : 'auto',
            borderRadius: isDesktop ? '28px 28px 0 0' : '32px 32px 0 0',
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
            paddingBottom: isDesktop ? undefined : 'env(safe-area-inset-bottom, 0px)',
            overflow: isDesktop ? 'auto' : undefined,
            zIndex: isDesktop ? 60 : undefined,
            pointerEvents: 'auto',
            animation: closing
              ? "slideDownSheet 0.3s cubic-bezier(0.2,0.8,0.2,1) forwards"
              : "slideUpSheet 0.35s cubic-bezier(0.2,0.8,0.2,1) forwards",
            fontFamily: "-apple-system, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif",
          }}
        >
          {/* Drag handle + close button */}
          <div
            style={{ position: "relative", touchAction: "none", cursor: "grab" }}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              (e.currentTarget as any)._dragStartY = e.clientY;
              const sheet = e.currentTarget.parentElement;
              if (sheet) sheet.style.transition = 'none';
            }}
            onPointerMove={(e) => {
              const startY = (e.currentTarget as any)._dragStartY;
              if (startY == null) return;
              const dy = e.clientY - startY;
              if (dy > 0) {
                const sheet = e.currentTarget.parentElement;
                if (sheet) sheet.style.transform = `translateY(${dy}px)`;
              }
            }}
            onPointerUp={(e) => {
              const startY = (e.currentTarget as any)._dragStartY;
              (e.currentTarget as any)._dragStartY = null;
              const sheet = e.currentTarget.parentElement;
              if (sheet) sheet.style.transition = '';
              const dy = startY != null ? e.clientY - startY : 0;
              if (dy > 60) {
                handleClose();
              } else if (sheet) {
                sheet.style.transform = '';
              }
            }}
          >
            <div style={{
              width: '36px',
              height: '4px',
              borderRadius: '2px',
              background: 'rgba(0,0,0,0.12)',
              margin: '6px auto 0',
            }} />
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handleClose}
              style={{
                position: 'absolute',
                top: '8px',
                right: '12px',
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'rgba(118,118,128,0.12)',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8e8e93" strokeWidth="2" strokeLinecap="round">
                <line x1="1" y1="1" x2="11" y2="11" />
                <line x1="11" y1="1" x2="1" y2="11" />
              </svg>
            </button>
          </div>

          <div style={{ padding: '16px 24px 32px' }}>
            {/* Rainbow splatter icon */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <svg width="120" height="120" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" style={{ overflow: 'hidden' }}>
                <defs>
                  <clipPath id="splat-clip-gift">
                    <path d="M438.024,210.133c0,7.488,6.08,13.551,13.551,13.551c7.488,0,13.569-6.063,13.569-13.551c0-7.479-6.081-13.552-13.569-13.552C444.104,196.581,438.024,202.654,438.024,210.133z" />
                    <path d="M400.097,376.503c-5.994,0-10.842,4.856-10.842,10.85c0,5.986,4.848,10.832,10.842,10.832c5.994,0,10.841-4.847,10.841-10.832C410.938,381.359,406.091,376.503,400.097,376.503z" />
                    <path d="M382.758,415.376c-12.284,0-22.238,9.956-22.238,22.238c0,12.274,9.955,22.229,22.238,22.229c12.283,0,22.238-9.955,22.238-22.229C404.997,425.332,395.041,415.376,382.758,415.376z" />
                    <circle cx="137.251" cy="426.904" r="16.8" />
                    <path d="M94.425,359.164c-4.778,0-8.669,3.874-8.669,8.678c0,4.778,3.892,8.66,8.669,8.66c4.796,0,8.67-3.883,8.67-8.66C103.094,363.038,99.22,359.164,94.425,359.164z" />
                    <path d="M54.865,151.063c6.29,0,11.38-5.1,11.38-11.389c0-6.281-5.09-11.38-11.38-11.38c-6.289,0-11.38,5.099-11.38,11.38C43.485,145.963,48.576,151.063,54.865,151.063z" />
                    <path d="M165.97,97.952c8.374,0,15.166-6.793,15.166-15.185c0-8.365-6.792-15.158-15.166-15.158s-15.168,6.794-15.168,15.158C150.802,91.158,157.596,97.952,165.97,97.952z" />
                    <path d="M450.775,300.632c-47.586-16.887-56.968-10.485-80.214-32.515c-5.56-5.255-5.438-22.49,25.47-18.425c15.497,2.042,26.008-6.506,26.008-18.702c0-8.131-9.799-19.433-24.393-13.821c-21.126,8.131-34.834-1.094-37.388-11.38c-3.25-13.004,0.434-27.832,54.814-54.996c66.646-33.332,28.423-93.983-23.924-36.859c-23.194,25.296-34.14,35.764-49.584,43.895c-13.864,7.288-30.49-0.27-17.895-17.069c4.882-6.507,13.17-11.527,15.445-19.511c3.249-11.38-6.324-21.952-14.628-21.952c-8.304,0-18.694,4.874-21.943,17.07c-4.882,22.359-17.322,21.24-23.194,14.785c-11.241-12.318-7.193-26.686-5.264-48.924c2.276-26.121,17.738-86.443-29.709-81.995c-22.88,2.146-29.639,23.715-22.238,62.267c9.208,47.856-4.725,81.257-19.597,88.007c-17.878,8.13-26.946,5.046-65.029-21.126c-20.24-13.926-42.584-1.703-47.152,14.628c-4.031,14.385,7.332,31.768,24.393,37.396c26.286,8.678,37.944,10.693,50.14,17.33c11.918,6.507,13.412,22.282,1.511,36.554c-11.918,14.282-42.705,2.468-88.224-0.782c-78.685-5.611-60.999,81.43,12.996,55.831c42.27-14.637,60.147-11.389,67.479-2.441c10.112,12.344,3.162,29.031-16.54,40.915c-62.858,37.944,7.61,85.078,33.618,32.515c10.876-21.961,23.385-28.71,35.756-23.846c10.094,3.979,23.02,39.204,8.409,86.72C206.885,466.473,207.771,512,238.33,512c28.563,0,33.028-42.539,28.164-88.875c-1.808-17.339-0.47-44.207,13.012-50.948c10.842-5.421,27.781-11.458,39.283,12.457c10.58,21.951,33.34,18.693,42.287,6.506c6.532-8.921,9.851-28.71-16.157-38.969c-30.995-12.249-19.615-45.58,3.961-42.323c26.026,3.588,43.868,13.17,74.794,39.569C466.829,386.233,522.234,325.989,450.775,300.632z" />
                  </clipPath>
                  <linearGradient id="rainbow-gift" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
                    <stop offset="0%" stopColor="#FF3B30" />
                    <stop offset="7%" stopColor="#FF6A1E" />
                    <stop offset="14%" stopColor="#FF9500" />
                    <stop offset="21%" stopColor="#FFB300" />
                    <stop offset="28%" stopColor="#FFCC00" />
                    <stop offset="35%" stopColor="#9ACD32" />
                    <stop offset="42%" stopColor="#34C759" />
                    <stop offset="50%" stopColor="#1AA3A3" />
                    <stop offset="57%" stopColor="#007AFF" />
                    <stop offset="64%" stopColor="#2C68EA" />
                    <stop offset="71%" stopColor="#5856D6" />
                    <stop offset="78%" stopColor="#8454DA" />
                    <stop offset="85%" stopColor="#AF52DE" />
                    <stop offset="92%" stopColor="#D946A8" />
                    <stop offset="100%" stopColor="#FF3B30" />
                  </linearGradient>
                </defs>
                <g clipPath="url(#splat-clip-gift)">
                  <rect x="-512" y="-512" width="1536" height="1536" fill="url(#rainbow-gift)" style={{ animation: "rainbowSlide 4s linear infinite" }} />
                </g>
              </svg>
            </div>

            {/* Title with Plus badge */}
            <h2 style={{ margin: '0 0 6px', fontSize: '20px', fontWeight: 700, color: '#1c1c1e' }}>
              <span style={{
                display: 'inline-block',
                background: 'rgba(118,118,128,0.12)',
                color: '#3c3c43',
                fontSize: 13,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 6,
                verticalAlign: 'middle',
                letterSpacing: '0.3px',
              }}>Plus</span>
            </h2>

            {/* Subtitle */}
            <p style={{ margin: '0 0 20px', fontSize: 14, color: '#8e8e93', lineHeight: 1.5 }}>
              {subtitle}
            </p>

            {/* Benefits list */}
            {state !== "claimed" && (
              <div style={{ background: 'rgba(118,118,128,0.08)', borderRadius: 14, padding: '4px 0', marginBottom: 20 }}>
                {/* Rainbow color */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
                      <div style={{
                        position: 'absolute', inset: -1, borderRadius: '50%',
                        background: "conic-gradient(#ff3b30, #ff6a1e, #ff9500, #ffb300, #ffcc00, #9acd32, #34c759, #1aa3a3, #007aff, #2c68ea, #5856d6, #8454da, #af52de, #d946a8, #ff3b30), linear-gradient(135deg, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30)",
                        backgroundSize: '100% 100%, 500% 500%',
                        backgroundBlendMode: 'overlay',
                        animation: 'rainbowFlow 6s ease infinite',
                        filter: 'blur(0.5px)',
                      }} />
                    </div>
                    <span style={{
                      fontSize: 15,
                      background: "linear-gradient(135deg, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #5856d6, #af52de, #ff3b30)",
                      backgroundSize: '500% 500%',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                      animation: 'rainbowTextFlow 6s ease infinite',
                    }}>Rainbow color</span>
                  </div>
                </div>
                <div style={{ height: 1, background: 'rgba(60,60,67,0.1)', marginLeft: 41 }} />

                {/* Crayon */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 390" width="18" height="50" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 28 }}>
                        <defs>
                          <mask id="gift-crayon-mask" style={{ maskType: 'alpha' } as any}>
                            <image href="/tools/crayon-tip.png" x="0" y="0" width="138" height="390" />
                          </mask>
                        </defs>
                        <image href="/tools/crayon-base.png" x="0" y="0" width="138" height="390" />
                        <rect x="0" y="0" width="138" height="390" fill="#FF9500" mask="url(#gift-crayon-mask)" />
                        <image href="/tools/crayon-tip-contour.png" x="0" y="0" width="138" height="390" />
                      </svg>
                    </div>
                    <span style={{ fontSize: 15, color: '#1c1c1e' }}>Crayon</span>
                  </div>
                </div>
                <div style={{ height: 1, background: 'rgba(60,60,67,0.1)', marginLeft: 41 }} />

                {/* Fountain Pen */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 318" width="18" height="42" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 18 }}>
                        <image href="/tools/fountainpen-base.png" x="0" y="0" width="138" height="318" />
                        <rect x="36" y="165" width="66" height="7" fill="#007AFF" />
                      </svg>
                    </div>
                    <span style={{ fontSize: 15, color: '#1c1c1e' }}>Fountain Pen</span>
                  </div>
                </div>
                <div style={{ height: 1, background: 'rgba(60,60,67,0.1)', marginLeft: 41 }} />

                {/* Watercolor */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '11px 11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(118,118,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      <svg viewBox="36 0 66 318" width="18" height="42" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 18 }}>
                        <defs>
                          <mask id="gift-watercolor-mask" style={{ maskType: 'alpha' } as any}>
                            <image href="/tools/watercolor-tip.png" x="0" y="0" width="138" height="318" />
                          </mask>
                        </defs>
                        <image href="/tools/watercolor-base.png" x="0" y="0" width="138" height="318" />
                        <rect x="0" y="0" width="138" height="318" fill="#34C759" mask="url(#gift-watercolor-mask)" />
                        <image href="/tools/watercolor-tip-contour.png" x="0" y="0" width="138" height="318" />
                      </svg>
                    </div>
                    <span style={{ fontSize: 15, color: '#1c1c1e' }}>Watercolor</span>
                  </div>
                </div>
                <div style={{ height: 1, background: 'rgba(60,60,67,0.1)', marginLeft: 41 }} />

                {/* Ink capacity */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <svg viewBox="0 0 24 24" fill="#1c1c1e" stroke="none" width="15" height="15" style={{ flexShrink: 0 }}>
                      <path d="M12 22C17 22 20 18 20 14C20 9 12 2 12 2C12 2 4 9 4 14C4 18 7 22 12 22Z" />
                    </svg>
                    <span style={{ fontSize: 15, color: '#1c1c1e' }}>Ink capacity</span>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>
                    <span style={{ color: '#8e8e93' }}>150</span>{" "}
                    <span style={{ color: '#8e8e93' }}>{"\u2192"}</span>{" "}
                    <span style={{ color: '#34c759' }}>300</span>
                  </span>
                </div>
                <div style={{ height: 1, background: 'rgba(60,60,67,0.1)', marginLeft: 41 }} />

                {/* Refill speed */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <svg viewBox="0 0 24 24" fill="#1c1c1e" stroke="#1c1c1e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" style={{ flexShrink: 0 }}>
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    <span style={{ fontSize: 15, color: '#1c1c1e' }}>Refill speed</span>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#34c759' }}>2x</span>
                </div>
              </div>
            )}

            {/* Action button */}
            <button
              onClick={buttonAction}
              disabled={state === "claiming"}
              style={{
                width: '100%',
                padding: '14px',
                background: '#007aff',
                color: '#ffffff',
                border: 'none',
                borderRadius: 100,
                fontWeight: 600,
                fontSize: 16,
                cursor: state === "claiming" ? 'default' : 'pointer',
                fontFamily: 'inherit',
                transition: 'transform 0.2s ease, opacity 0.3s ease',
                opacity: state === "claiming" ? 0.6 : 1,
              }}
            >
              {buttonText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
