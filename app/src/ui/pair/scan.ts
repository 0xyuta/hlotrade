/** QR decoding for the phone's pair page: the browser's BarcodeDetector where it reads QR codes, else jsQR, loaded only then. */
export type QrDecode = (frame: ImageData, source: CanvasImageSource) => Promise<string | null>;
interface DetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
export interface DetectorCtor {
  new (opts: { formats: string[] }): DetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}
export type JsQr = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null;
export interface DecoderEnv {
  BarcodeDetector?: DetectorCtor;
  loadJsQr(): Promise<JsQr>;
}

export const SCAN_INTERVAL_MS = 250;

export const browserDecoderEnv = (): DecoderEnv => ({
  BarcodeDetector: (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector,
  // [P4 §4] jsqr 1.4.0, its own chunk: downloaded only on browsers without a QR-capable BarcodeDetector (every iPhone).
  loadJsQr: () => import("jsqr").then((m) => m.default as unknown as JsQr),
});

export async function makeDecoder(env: DecoderEnv): Promise<{ kind: "native" | "jsqr"; decode: QrDecode }> {
  const BD = env.BarcodeDetector;
  if (BD) {
    try {
      const formats = BD.getSupportedFormats ? await BD.getSupportedFormats() : ["qr_code"];
      if (formats.includes("qr_code")) {
        const d = new BD({ formats: ["qr_code"] });
        return { kind: "native", decode: async (_frame, source) => (await d.detect(source))[0]?.rawValue ?? null };
      }
    } catch {
      // a detector that cannot even list its formats: use jsQR
    }
  }
  const jsqr = await env.loadJsQr();
  return { kind: "jsqr", decode: async (frame) => jsqr(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" })?.data ?? null };
}

export type CameraProblem = "denied" | "nocamera" | "failed";

export function cameraProblem(e: unknown): CameraProblem {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "nocamera";
  return "failed";
}

export const CAMERA_TEXT: Record<CameraProblem, string> = {
  denied: "The camera is blocked for this page. Allow it in the browser's site settings, or type the code instead.",
  nocamera: "No camera is available here. Type the code instead.",
  failed: "The camera did not start. Type the code instead.",
};

/**
 * Starts the back camera into `video` (inline, muted). Returns the stopper, which releases the camera. `isDead` says the
 * caller gave up meanwhile (its effect was cleaned up): a camera that arrives then is released at once and never put
 * on the element, so a slow older start cannot replace, then blank, a newer one's video.
 */
export async function startCamera(
  video: HTMLVideoElement,
  media: Pick<MediaDevices, "getUserMedia"> | undefined = globalThis.navigator?.mediaDevices,
  isDead: () => boolean = () => false,
): Promise<() => void> {
  if (!media?.getUserMedia) throw Object.assign(new Error("This browser has no camera API here."), { name: "NotFoundError" });
  const stream = await media.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
  const stop = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (video.srcObject === stream) video.srcObject = null; // not a newer camera's stream on the same element
  };
  if (isDead()) {
    stop();
    return stop;
  }
  try {
    video.setAttribute("playsinline", ""); // iOS: no full-screen player
    video.muted = true;
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    stop();
    throw e;
  }
  return stop;
}
