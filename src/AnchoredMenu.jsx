import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function AnchoredMenu({ anchor, menuRef, children }) {
  const [position, setPosition] = useState({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0, ceiling = viewport?.offsetTop || 0;
      const availableWidth = viewport?.width || window.innerWidth;
      const bottom = ceiling + (viewport?.height || window.innerHeight);
      const width = Math.max(0, Math.min(420, availableWidth - 16));
      const top = Math.max(ceiling + 8, Math.min(rect.bottom + 8, bottom - 100));
      setPosition({ position: 'fixed', left: Math.max(left + 8, Math.min(rect.left, left + availableWidth - width - 8)), top,
        width, minWidth: 0, maxHeight: Math.max(0, bottom - top - 12), overflowY: 'auto', margin: 0, zIndex: 10000 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [anchor]);
  return createPortal(<div ref={menuRef} className="dropdown-menu header-model-menu" style={position}>{children}</div>, document.body);
}
