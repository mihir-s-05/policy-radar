import { useEffect, useState } from "react";

export function useMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 1023px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      // A keyboard may resize only the visual viewport. Leave pinch zoom alone.
      const useVisual = query.matches && viewport && Math.abs(viewport.scale - 1) < 0.01;
      root.style.setProperty("--visible-height", `${useVisual ? viewport.height : window.innerHeight}px`);
      root.style.setProperty("--viewport-top", `${useVisual ? viewport.offsetTop : 0}px`);
    };
    const change = () => { setIsMobile(query.matches); update(); };
    query.addEventListener("change", change);
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    update();
    return () => {
      query.removeEventListener("change", change);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      root.style.removeProperty("--visible-height");
      root.style.removeProperty("--viewport-top");
    };
  }, []);

  return isMobile;
}
