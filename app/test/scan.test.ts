import { describe, expect, it, vi } from "vitest";
import { CAMERA_TEXT, cameraProblem, makeDecoder, startCamera, type DetectorCtor, type JsQr } from "../src/ui/pair/scan";

const frame = { data: new Uint8ClampedArray(16), width: 2, height: 2 } as unknown as ImageData;
const src = {} as CanvasImageSource;

function detector(formats: string[] | Error, value: string | null): DetectorCtor {
  return class {
    static getSupportedFormats = async () => {
      if (formats instanceof Error) throw formats;
      return formats;
    };
    constructor(public o: { formats: string[] }) {}
    async detect() {
      return value === null ? [] : [{ rawValue: value }];
    }
  } as unknown as DetectorCtor;
}
const jsqr = (value: string | null) => vi.fn<JsQr>(() => (value === null ? null : { data: value }));

describe("makeDecoder", () => {
  it("uses BarcodeDetector when it reads QR codes, and never loads jsQR", async () => {
    const loadJsQr = vi.fn(async () => jsqr("x"));
    const d = await makeDecoder({ BarcodeDetector: detector(["ean_13", "qr_code"], "hello"), loadJsQr });
    expect(d.kind).toBe("native");
    expect(await d.decode(frame, src)).toBe("hello");
    expect(loadJsQr).not.toHaveBeenCalled();
  });
  it("falls back to jsQR when there is no BarcodeDetector (iOS Safari)", async () => {
    const decode = jsqr("code");
    const d = await makeDecoder({ loadJsQr: async () => decode });
    expect(d.kind).toBe("jsqr");
    expect(await d.decode(frame, src)).toBe("code");
    expect(decode).toHaveBeenCalledWith(frame.data, 2, 2, { inversionAttempts: "dontInvert" });
  });
  it("falls back to jsQR when BarcodeDetector cannot read QR codes or fails", async () => {
    expect((await makeDecoder({ BarcodeDetector: detector(["ean_13"], "x"), loadJsQr: async () => jsqr(null) })).kind).toBe("jsqr");
    expect((await makeDecoder({ BarcodeDetector: detector(new Error("no"), "x"), loadJsQr: async () => jsqr(null) })).kind).toBe("jsqr");
  });
  it("no code in the frame is null", async () => {
    expect(await (await makeDecoder({ BarcodeDetector: detector(["qr_code"], null), loadJsQr: async () => jsqr(null) })).decode(frame, src)).toBeNull();
    expect(await (await makeDecoder({ loadJsQr: async () => jsqr(null) })).decode(frame, src)).toBeNull();
  });
});

describe("camera", () => {
  it("maps browser errors to what the page says", () => {
    expect(cameraProblem({ name: "NotAllowedError" })).toBe("denied");
    expect(cameraProblem({ name: "SecurityError" })).toBe("denied");
    expect(cameraProblem({ name: "NotFoundError" })).toBe("nocamera");
    expect(cameraProblem({ name: "OverconstrainedError" })).toBe("nocamera");
    expect(cameraProblem({ name: "NotReadableError" })).toBe("failed");
    expect(cameraProblem(new Error("x"))).toBe("failed");
    expect(CAMERA_TEXT.denied).toMatch(/type the code/);
  });
  const fakeVideo = (play: () => Promise<void> = async () => {}) => ({ setAttribute: vi.fn(), play: vi.fn(play), srcObject: null as unknown, muted: false }) as unknown as HTMLVideoElement;
  const fakeMedia = () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    return { track, media: { getUserMedia: vi.fn(async () => stream) } };
  };
  it("asks for the back camera only, plays inline, and the stopper stops every track", async () => {
    const { track, media } = fakeMedia();
    const v = fakeVideo();
    const stop = await startCamera(v, media);
    expect(media.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: "environment" } }, audio: false });
    expect(v.setAttribute).toHaveBeenCalledWith("playsinline", "");
    expect(v.muted).toBe(true);
    stop();
    expect(track.stop).toHaveBeenCalled();
    expect(v.srcObject).toBeNull();
  });
  it("a video that will not play releases the camera and throws", async () => {
    const { track, media } = fakeMedia();
    await expect(startCamera(fakeVideo(async () => { throw new Error("autoplay"); }), media)).rejects.toThrow("autoplay");
    expect(track.stop).toHaveBeenCalled();
  });
  it("a stopper only clears the video if the video still shows its own stream (a restart or StrictMode's second effect started another on the same element)", async () => {
    const first = fakeMedia();
    const second = fakeMedia();
    const v = fakeVideo();
    const stopFirst = await startCamera(v, first.media);
    const stopSecond = await startCamera(v, second.media);
    stopFirst();
    expect(first.track.stop).toHaveBeenCalled();
    expect(v.srcObject).not.toBeNull(); // the second camera's stream stays
    expect(second.track.stop).not.toHaveBeenCalled();
    stopSecond();
    expect(v.srcObject).toBeNull();
  });
  it("an older start that resolves after a newer one never takes the element: its camera is released and the newer video stays (Task 7 review m1)", async () => {
    const older = fakeMedia();
    let grant!: () => void;
    older.media.getUserMedia.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (grant = r));
      return { getTracks: () => [older.track] } as unknown as MediaStream;
    });
    const newer = fakeMedia();
    const v = fakeVideo();
    let olderDead = false;
    const first = startCamera(v, older.media, () => olderDead);
    await startCamera(v, newer.media);
    const shown = v.srcObject;
    expect(shown).not.toBeNull();
    olderDead = true; // its effect was cleaned up meanwhile
    grant();
    const stopOlder = await first;
    expect(older.track.stop).toHaveBeenCalled();
    expect(v.srcObject).toBe(shown); // not overwritten, not blanked
    expect(v.play).toHaveBeenCalledTimes(1);
    stopOlder(); // the dead effect's cleanup: still harmless
    expect(v.srcObject).toBe(shown);
    expect(newer.track.stop).not.toHaveBeenCalled();
  });
  it("no camera API (an insecure page, an old browser) is 'nocamera'", async () => {
    const e = await startCamera(fakeVideo(), undefined).catch((x: unknown) => x);
    expect(cameraProblem(e)).toBe("nocamera");
  });
});
