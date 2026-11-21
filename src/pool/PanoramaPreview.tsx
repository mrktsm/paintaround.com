import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

/** A local image preview only; no connection to the painting prototype. */
export default function PanoramaPreview({ url, title }: { url: string; title: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Loading panorama…');

  useEffect(() => {
    const mount = mountRef.current!;
    let disposed = false;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch {
      const frame = requestAnimationFrame(() => setStatus('360° preview requires WebGL. You can still download the panorama below.'));
      return () => cancelAnimationFrame(frame);
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    const geometry = new THREE.SphereGeometry(500, 64, 40);
    geometry.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    scene.add(new THREE.Mesh(geometry, material));
    let yaw = 0, pitch = 0;
    let dragging: { id: number; x: number; y: number } | null = null;
    const render = () => {
      camera.lookAt(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      renderer.render(scene, camera);
    };
    const resize = () => {
      camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    const texture = new THREE.TextureLoader().load(url, image => {
      if (disposed) { image.dispose(); return; }
      image.colorSpace = THREE.SRGBColorSpace;
      material.map = image;
      material.needsUpdate = true;
      setStatus('');
      render();
    }, undefined, () => { if (!disposed) setStatus('Could not load this panorama. Try downloading the image below.'); });
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
      mount.setPointerCapture(event.pointerId);
      mount.focus();
    };
    const move = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== dragging.id) return;
      yaw -= (event.clientX - dragging.x) * 0.004;
      pitch = THREE.MathUtils.clamp(pitch + (event.clientY - dragging.y) * 0.004, -1.5, 1.5);
      dragging.x = event.clientX; dragging.y = event.clientY;
      render();
    };
    const up = () => { dragging = null; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      camera.fov = THREE.MathUtils.clamp(camera.fov + event.deltaY * 0.04, 30, 100);
      camera.updateProjectionMatrix(); render();
    };
    const key = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') yaw -= 0.12;
      if (event.key === 'ArrowRight') yaw += 0.12;
      if (event.key === 'ArrowUp') pitch = Math.min(1.5, pitch + 0.12);
      if (event.key === 'ArrowDown') pitch = Math.max(-1.5, pitch - 0.12);
      if (event.key === '+' || event.key === '=') camera.fov = Math.max(30, camera.fov - 5);
      if (event.key === '-') camera.fov = Math.min(100, camera.fov + 5);
      camera.updateProjectionMatrix(); render();
    };
    mount.addEventListener('pointerdown', down);
    mount.addEventListener('pointermove', move);
    mount.addEventListener('pointerup', up);
    mount.addEventListener('pointercancel', up);
    mount.addEventListener('wheel', wheel, { passive: false });
    mount.addEventListener('keydown', key);
    return () => {
      disposed = true;
      observer.disconnect();
      mount.removeEventListener('pointerdown', down);
      mount.removeEventListener('pointermove', move);
      mount.removeEventListener('pointerup', up);
      mount.removeEventListener('pointercancel', up);
      mount.removeEventListener('wheel', wheel);
      mount.removeEventListener('keydown', key);
      geometry.dispose(); material.dispose(); texture.dispose(); renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url]);

  return <div className="pool-panorama-wrap">
    <div ref={mountRef} className="pool-panorama" tabIndex={0} role="region" aria-label={`360° view of ${title}. Drag or use arrow keys to look around; scroll or use plus and minus to zoom.`} />
    {status && <div className="pool-viewer-status" role="status">{status}</div>}
    <span className="pool-viewer-hint">Drag to look around · scroll to zoom · arrow keys also work</span>
  </div>;
}
