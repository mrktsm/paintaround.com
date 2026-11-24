/** A photo fades in over its dark background (the skeleton) once loaded, also when cached. */
export function fadeInWhenLoaded(img: HTMLImageElement | null): void {
  if (!img) return;
  if (img.complete && img.naturalWidth) img.classList.add('is-loaded');
  else img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
}
