import { useState, type ReactNode, type RefObject } from 'react';
import type { Map } from 'maplibre-gl';
import Compass from '../components/Compass';
import { DARK_UI } from '../theme';
import { ESRI_DATA_CREDIT } from './esriPreviewStyle';
import { MAP_SOURCE, type MapSource } from './mapStyles';

/** The AGPL asks for this to be offered to everyone using the site. If you run a changed version, link to yours. */
const SOURCE_CODE = 'https://github.com/mrktsm/paintaround.com';

const CREDITS: Record<MapSource, ReactNode> = {
  esri: ESRI_DATA_CREDIT,
  eox: <><a href="https://cloudless.eox.at" target="_blank" rel="noreferrer">EOxCloudless</a> by <a href="https://eox.at" target="_blank" rel="noreferrer">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2024), <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0</a>. Overlay rendering © EOX and MapServer.</>,
  maptiler: <>© <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer">MapTiler</a></>,
  stadia: <>Imagery © CNES, Airbus DS, PlanetObserver · © <a href="https://stadiamaps.com/" target="_blank" rel="noreferrer">Stadia Maps</a> · © OpenMapTiles</>,
  carto: <>© <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a></>,
};

/** The compass, zoom buttons and credits over the map. */
export default function MapControls({ map, bearing }: { map: RefObject<Map | null>; bearing: number }) {
  const [creditOpen, setCreditOpen] = useState(false);
  return (
    <>
      <div className="ex-ctl ex-ctl--tr">
        <Compass bearing={bearing} background={DARK_UI ? 'rgba(36, 36, 38, 0.82)' : undefined} onClick={() => map.current?.easeTo({ bearing: 0, pitch: 0 })} />
      </div>

      {/* MapTiler free plan requires their logo on the map */}
      {MAP_SOURCE === 'maptiler' && (
        <a className="ex-maptiler-logo" href="https://www.maptiler.com" target="_blank" rel="noreferrer" aria-label="MapTiler">
          <img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler" />
        </a>
      )}

      <div className="ex-ctl ex-ctl--br">
        {/* map data credit (required by the OpenStreetMap licence), behind a small (i) */}
        <div className="ex-info">
          {creditOpen && (
            <div className="ex-info__pop" role="dialog" aria-label="Map credits">
              {MAP_SOURCE === 'esri' && (
                <a className="ex-info__row" href="https://www.esri.com/" target="_blank" rel="noreferrer">
                  Powered by Esri
                  <svg width="7" height="12" viewBox="0 0 7 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1l5 5-5 5" /></svg>
                </a>
              )}
              <div className="ex-info__caption">Sources</div>
              <p className="ex-info__body">
                {CREDITS[MAP_SOURCE]}
                <br />© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
              </p>
            </div>
          )}
          {/* one small line, like Apple Maps' legal links: "© Esri" opens the credits panel above
              (Esri's required "Powered by Esri" + every source); Privacy, Terms and the source code sit beside it */}
          <div className="ex-credit">
            <button aria-label="Map credits" aria-expanded={creditOpen} onClick={() => setCreditOpen((v) => !v)}>
              {MAP_SOURCE === 'esri' ? '© Esri' : 'Map data'}
            </button>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href={SOURCE_CODE} target="_blank" rel="noreferrer">Source code</a>
          </div>
        </div>
        <div className="ex-stack">
          <button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14" /></svg>
          </button>
        </div>
      </div>

    </>
  );
}
