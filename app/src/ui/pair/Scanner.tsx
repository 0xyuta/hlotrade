import { useEffect, useRef, useState } from "react";
import { SCAN_INTERVAL_MS, browserDecoderEnv, cameraProblem, makeDecoder, startCamera, type CameraProblem, type DecoderEnv } from "./scan";

export interface ScannerProps {
  /** Called with each decoded text. Return true to stop (accepted), false to keep scanning (not a pairing code). Never log the text: it is a private key. */
  onText(text: string): boolean;
  onProblem(p: CameraProblem): void;
  env?: () => DecoderEnv;
}

/** The hidden canvas holds the last camera frame, which may be the key's QR: reset it (zero size drops its pixels). */
const wipe = (c: HTMLCanvasElement | null) => {
  if (c) {
    c.width = 0;
    c.height = 0;
  }
};

/**
 * The camera view and the decode loop. The camera stops when a code is accepted, when the component goes away, and when
 * the page is hidden (a hidden tab or a phone locked or switched away from keeps no camera; it does not start by itself
 * when the page returns, so the user restarts it). The canvas is cleared whenever the loop ends.
 */
export function Scanner({ onText, onProblem, env = browserDecoderEnv }: ScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const handlers = useRef({ onText, onProblem });
  handlers.current = { onText, onProblem };
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const hide = () => setPaused(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", hide);
    };
  }, []);

  useEffect(() => {
    if (paused) return;
    const frame = canvas.current;
    let dead = false;
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      // The camera and the decoder start together (the permission prompt does not wait for the jsQR chunk),
      // but each result is taken on its own so a failed decoder load still releases a camera that did start.
      const [cam, dec] = await Promise.allSettled([startCamera(video.current!, undefined, () => dead), makeDecoder(env())]);
      if (cam.status === "fulfilled") {
        stop = cam.value;
        if (dead) return stop();
      }
      if (cam.status === "rejected" || dec.status === "rejected") {
        stop?.();
        const reason: unknown = cam.status === "rejected" ? cam.reason : (dec as PromiseRejectedResult).reason;
        if (!dead) handlers.current.onProblem(cameraProblem(reason));
        return;
      }
      const decoder = dec.value;
      const tick = async () => {
        if (dead) return;
        const v = video.current;
        const c = canvas.current;
        if (v && c && v.videoWidth > 0) {
          const w = Math.min(v.videoWidth, 640);
          const h = Math.round((v.videoHeight * w) / v.videoWidth);
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(v, 0, 0, w, h);
            const text = await decoder.decode(ctx.getImageData(0, 0, w, h), c).catch(() => null);
            if (dead) return;
            if (text !== null && handlers.current.onText(text)) {
              dead = true;
              stop?.();
              wipe(c);
              return;
            }
          }
        }
        timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
      };
      void tick();
    })();
    return () => {
      dead = true;
      clearTimeout(timer);
      stop?.();
      wipe(frame);
    };
  }, [env, paused]);

  return (
    <div className="scan">
      <video ref={video} className="scan-video" muted playsInline aria-label="Camera view" />
      <canvas ref={canvas} hidden />
      {paused && (
        <button className="btn wide" style={{ marginTop: 10 }} onClick={() => setPaused(false)}>
          Restart the camera
        </button>
      )}
    </div>
  );
}
