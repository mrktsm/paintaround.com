import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import ViewPage from './view/ViewPage.tsx' // before Explore: the order of their CSS matters
import PrivacyPolicy from './PrivacyPolicy.tsx'
import Terms from './Terms.tsx'
import ExplorePage from './explore/ExplorePage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ExplorePage />} />
        <Route path="/view" element={<ViewPage />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/explore" element={<ExplorePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
