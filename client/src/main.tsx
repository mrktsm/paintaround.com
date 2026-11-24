import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import ViewPage, { OldViewLink } from './view/ViewPage.tsx' // before Explore: the order of their CSS matters
import PrivacyPolicy from './legal/PrivacyPolicy.tsx'
import Terms from './legal/Terms.tsx'
import ExplorePage from './explore/ExplorePage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ExplorePage />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/view" element={<OldViewLink />} />
        <Route path="/:place" element={<ViewPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
