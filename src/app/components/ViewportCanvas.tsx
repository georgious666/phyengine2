import { memo, startTransition, useEffect, useRef, useState } from "react";
import { DEFAULT_ENGINE_CONFIG } from "../../engine/defaults";
import { HmrEngine } from "../../engine/HmrEngine";
import type { EngineFrameState, RenderMode } from "../../engine/types";

interface ViewportCanvasProps {
  presetId: string;
  renderMode: RenderMode;
  controls: Record<string, number>;
  onFrameState: (state: EngineFrameState) => void;
  onStatus: (status: string) => void;
}

const UI_FRAMESTATE_CADENCE_MS = 120;

export const ViewportCanvas = memo(function ViewportCanvas({
  presetId,
  renderMode,
  controls,
  onFrameState,
  onStatus
}: ViewportCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<HmrEngine | null>(null);
  const presetIdRef = useRef(presetId);
  const dragStateRef = useRef<{ dragging: boolean; x: number; y: number }>({
    dragging: false,
    x: 0,
    y: 0
  });
  const lastFrameStatePushRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [overlayMessage, setOverlayMessage] = useState("Preparing field and shell buffers...");

  useEffect(() => {
    presetIdRef.current = presetId;
  }, [presetId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const hostCanvas = canvas;
    let localEngine: HmrEngine | null = null;

    let cancelled = false;
    let animationFrame = 0;
    let lastTime = performance.now();
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !engineRef.current) {
        return;
      }
      engineRef.current.resize(entry.contentRect.width, entry.contentRect.height);
    });

    async function start() {
      try {
        setReady(false);
        setOverlayMessage("Preparing field and shell buffers...");
        const engine = new HmrEngine(hostCanvas, DEFAULT_ENGINE_CONFIG);
        localEngine = engine;
        await engine.init();
        if (cancelled) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        engine.loadPreset(presetIdRef.current);
        engine.resize(hostCanvas.clientWidth || 1, hostCanvas.clientHeight || 1);
        resizeObserver.observe(hostCanvas);
        setReady(true);
        setOverlayMessage("");
        onStatus("WebGPU ready. Drag to orbit, wheel to zoom.");
        lastFrameStatePushRef.current = 0;

        const frame = (now: number) => {
          if (!engineRef.current) {
            return;
          }
          const dt = Math.min(0.05, (now - lastTime) / 1000);
          lastTime = now;
          engineRef.current.step(dt);
          engineRef.current.render();
          const frameState = engineRef.current.getFrameState();
          if (
            lastFrameStatePushRef.current === 0 ||
            now - lastFrameStatePushRef.current >= UI_FRAMESTATE_CADENCE_MS
          ) {
            lastFrameStatePushRef.current = now;
            startTransition(() => {
              onFrameState(frameState);
            });
          }
          animationFrame = requestAnimationFrame(frame);
        };
        animationFrame = requestAnimationFrame(frame);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to initialize renderer.";
        setOverlayMessage(message);
        onStatus(message);
      }
    }

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      if (engineRef.current) {
        engineRef.current.dispose();
        engineRef.current = null;
      } else {
        localEngine?.dispose();
      }
    };
  }, [onFrameState, onStatus]);

  useEffect(() => {
    if (!engineRef.current) {
      return;
    }
    engineRef.current.loadPreset(presetId);
  }, [presetId]);

  useEffect(() => {
    if (!engineRef.current) {
      return;
    }
    engineRef.current.updateParams({
      renderMode,
      config: {
        surfaceThreshold: controls.surfaceThreshold ?? DEFAULT_ENGINE_CONFIG.surfaceThreshold,
        pointBudget: Math.round(controls.pointBudget ?? DEFAULT_ENGINE_CONFIG.pointBudget),
        quality: {
          raymarchSteps: Math.round(controls.raymarchSteps ?? DEFAULT_ENGINE_CONFIG.quality.raymarchSteps),
          surfaceSteps: Math.round(controls.surfaceSteps ?? DEFAULT_ENGINE_CONFIG.quality.surfaceSteps),
          shellDensity: controls.shellDensity ?? DEFAULT_ENGINE_CONFIG.quality.shellDensity,
          pointSizeScale: controls.pointSizeScale ?? DEFAULT_ENGINE_CONFIG.quality.pointSizeScale,
          shellOpacity: DEFAULT_ENGINE_CONFIG.quality.shellOpacity,
          surfaceResolutionScale: DEFAULT_ENGINE_CONFIG.quality.surfaceResolutionScale,
          markerDensity: controls.markerDensity ?? DEFAULT_ENGINE_CONFIG.quality.markerDensity,
          vorticityGain: controls.vorticityGain ?? DEFAULT_ENGINE_CONFIG.quality.vorticityGain,
          burstGain: controls.burstGain ?? DEFAULT_ENGINE_CONFIG.quality.burstGain
        }
      },
      post: {
        exposure: controls.exposure ?? 1.1
      }
    });
  }, [controls, renderMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      dragStateRef.current = {
        dragging: true,
        x: event.clientX,
        y: event.clientY
      };
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current.dragging || !engineRef.current) {
        return;
      }
      const deltaX = event.clientX - dragStateRef.current.x;
      const deltaY = event.clientY - dragStateRef.current.y;
      dragStateRef.current = {
        dragging: true,
        x: event.clientX,
        y: event.clientY
      };
      engineRef.current.orbit(deltaX * 0.0045, deltaY * 0.0035);
    };

    const onPointerUp = (event: PointerEvent) => {
      dragStateRef.current.dragging = false;
      canvas.releasePointerCapture(event.pointerId);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      engineRef.current?.zoom(event.deltaY * 0.0025);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div className="viewport-shell">
      <canvas ref={canvasRef} className={`viewport-canvas ${ready ? "ready" : ""}`} />
      {!ready ? <div className="viewport-overlay">{overlayMessage}</div> : null}
    </div>
  );
});
