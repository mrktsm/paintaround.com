import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import './index.css'
import App from './App.tsx'
import PrivacyPolicy from './PrivacyPolicy.tsx'
import Terms from './Terms.tsx'
import ExplorePage from './explore/ExplorePage.tsx'
import DeepView from './deep/DeepView.tsx'
const PoolPage = lazy(() => import('./pool/PoolPage.tsx'));
const PaintMaterialTest = lazy(() => import('./deep/PaintMaterialTest.tsx'));
// import Footer from './Footer.tsx'
// No accounts: the old /classic map, /gift codes and /moderate, /auto-mod dashboards (all sign-in based)
// are no longer routed. Their files are kept for reference.

if (Capacitor.isNativePlatform()) {
  document.getElementById('root')!.classList.add('native');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ExplorePage />} />
        <Route path="/view" element={<App />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/deep" element={<DeepView />} />
        <Route path="/paint-test" element={<Suspense fallback={<p>Loading paint test…</p>}><PaintMaterialTest /></Suspense>} />
        <Route path="/pool" element={<Suspense fallback={<p>Loading panorama pool…</p>}><PoolPage /></Suspense>} />
        <Route path="/explore" element={<ExplorePage />} />
      </Routes>
      {/* <Footer /> */}
    </BrowserRouter>
  </StrictMode>,
)
