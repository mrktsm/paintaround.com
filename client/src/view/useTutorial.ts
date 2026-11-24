import { useCallback, useState } from 'react';

const SEEN = 'tutorialSeen';

/** The first visit's tutorial: there until you look around for the first time. */
export function useTutorial() {
  const [state, setState] = useState<'shown' | 'fading' | 'gone'>(() => (localStorage.getItem(SEEN) ? 'gone' : 'shown'));
  const dismiss = useCallback(() => {
    localStorage.setItem(SEEN, '1');
    setState(s => (s === 'shown' ? 'fading' : s));
    setTimeout(() => setState('gone'), 400);
  }, []);
  return { state, dismiss };
}
