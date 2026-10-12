import { useEffect, useState } from "react";

export function useMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 1023px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      // Let dvh follow Safari's toolbar. Only size to the visual viewport for a keyboard.
      const editing = document.activeElement?.matches("input, textarea, [contenteditable=true]");
      const keyboard = query.matches && editing && viewport && Math.abs(viewport.scale - 1) < 0.01 && viewport.height < window.innerHeight - 100;
      if (keyboard) root.style.setProperty("--visible-height", `${viewport.height}px`);
      else root.style.removeProperty("--visible-height");
      root.style.setProperty("--viewport-top", `${keyboard ? viewport.offsetTop : 0}px`);
    };
    const scroll = () => { if (document.activeElement?.matches("input, textarea, [contenteditable=true]")) update(); };
    const change = () => { setIsMobile(query.matches); update(); };
    query.addEventListener("change", change);
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", scroll);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    update();
    return () => {
      query.removeEventListener("change", change);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", scroll);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      root.style.removeProperty("--visible-height");
      root.style.removeProperty("--viewport-top");
    };
  }, []);

  return isMobile;
}
