import React, { useEffect, useRef } from 'react';
import { ArrowRight } from 'lucide-react';

export function PixelIntro({ done }) {
  const canvas = useRef(null);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    let frame, cancelled = false;
    const limit = setTimeout(done, 3000);
    const source = new Image();
    source.src = '/brand/zecpaid-mascot-transparent.png';
    source.onload = () => {
      if (cancelled) return;
      const side = 384, block = 16, target = canvas.current.getContext('2d');
      const sprite = document.createElement('canvas'); sprite.width = side; sprite.height = side;
      const art = sprite.getContext('2d', { willReadFrequently: true });
      art.imageSmoothingEnabled = false; art.drawImage(source, 0, 0, side, side);
      const pixels = art.getImageData(0, 0, side, side).data, tiles = [];
      for (let y = 0; y < side; y += block) for (let x = 0; x < side; x += block) {
        let seed = Math.imul(x / block + 1, 374761393) + Math.imul(y / block + 1, 668265263);
        seed = Math.imul(seed ^ (seed >>> 13), 1274126177);
        seed = (seed ^ (seed >>> 16)) >>> 0;
        const distance = Math.hypot(x / side - .5, y / side - .5) / Math.SQRT1_2;
        const alpha = pixels[((y + block / 2) * side + x + block / 2) * 4 + 3];
        tiles.push({ x, y, threshold: .48 * distance + .46 * (seed / 4294967295), opaque: alpha > 180 });
      }
      const start = performance.now();
      target.imageSmoothingEnabled = false;
      const draw = now => {
        if (cancelled) return;
        const progress = Math.max(0, Math.min(1, (now - start - 100) / 1500));
        target.clearRect(0, 0, side, side);
        for (const tile of tiles) {
          if (progress >= tile.threshold) target.drawImage(sprite, tile.x, tile.y, block, block, tile.x, tile.y, block, block);
          else if (tile.opaque && progress > tile.threshold - .055) { target.fillStyle = '#f5c344'; target.fillRect(tile.x + 4, tile.y + 4, 8, 8); }
        }
        if (progress < 1) frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    };
    source.onerror = done;
    return () => { cancelled = true; clearTimeout(limit); cancelAnimationFrame(frame); source.onload = null; source.onerror = null; };
  }, [done]);
  return <div className="intro pixel-intro" role="dialog" aria-label="ZecPaid introduction"><div className="pixel-intro-center"><canvas ref={canvas} width="384" height="384" role="img" aria-label="The golden ZecPaid messenger appearing in pixels" /><span className="pixel-intro-name">ZecPaid</span></div><button className="intro-skip" onClick={done}>Skip intro <ArrowRight size={17} /></button></div>;
}
