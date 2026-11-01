// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scanner } from "../src/ui/pair/Scanner";
import type { DecoderEnv, JsQr } from "../src/ui/pair/scan";

const track = { stop: vi.fn() };

beforeEach(() => {
  track.stop.mockClear();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as { visibilityState?: unknown }).visibilityState; // back to the prototype's getter
});
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));
const jsqrEnv = (data: string | null) => () => ({ loadJsQr: async (): Promise<JsQr> => () => (data === null ? null : { data }) });
const hide = () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
};

describe("Scanner", () => {
  it("a decoder that fails to load releases the camera and reports a problem", async () => {
    const onProblem = vi.fn();
    const env = (): DecoderEnv => ({ loadJsQr: async () => { throw new Error("chunk"); } });
    render(<Scanner onText={() => true} onProblem={onProblem} env={env} />);
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith("failed"));
    expect(track.stop).toHaveBeenCalled();
  });
  it("a refused camera is reported as denied", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ name: "NotAllowedError" });
    const onProblem = vi.fn();
    const jsqr: JsQr = () => null;
    render(<Scanner onText={() => true} onProblem={onProblem} env={() => ({ loadJsQr: async () => jsqr })} />);
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith("denied"));
  });
  it("leaving the page releases the camera", async () => {
    const jsqr: JsQr = () => null;
    const { unmount } = render(<Scanner onText={() => true} onProblem={() => {}} env={() => ({ loadJsQr: async () => jsqr })} />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    unmount();
    expect(track.stop).toHaveBeenCalled();
  });
  it("a camera that arrives after the scanner went away is released without ever being played (Task 7 review m1)", async () => {
    let grant!: () => void;
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await new Promise<void>((r) => (grant = r));
      return { getTracks: () => [track] };
    });
    const { unmount } = render(<Scanner onText={() => true} onProblem={() => {}} env={jsqrEnv(null)} />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    unmount();
    grant();
    await settle();
    expect(track.stop).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  describe("a frame is read", () => {
    beforeEach(() => {
      vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(400);
      vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(300);
      const ctx = { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(4), width: 400, height: 300 }) };
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    });
    it("an accepted text stops the camera, ends the loop and clears the hidden canvas, so the key's QR frame does not linger", async () => {
      const onText = vi.fn(() => true);
      const { container } = render(<Scanner onText={onText} onProblem={() => {}} env={jsqrEnv("a key")} />);
      await waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
      expect(onText).toHaveBeenCalledWith("a key");
      expect(track.stop).toHaveBeenCalled();
      const canvas = container.querySelector("canvas")!;
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      await new Promise((r) => setTimeout(r, 400));
      expect(onText).toHaveBeenCalledTimes(1); // the loop ended
    });
    it("a refused text keeps the camera on and scanning", async () => {
      const onText = vi.fn(() => false);
      render(<Scanner onText={onText} onProblem={() => {}} env={jsqrEnv("not a code")} />);
      await waitFor(() => expect(onText.mock.calls.length).toBeGreaterThan(1));
      expect(track.stop).not.toHaveBeenCalled();
    });
    it("unmounting clears the canvas too", async () => {
      const onText = vi.fn(() => false);
      const { container, unmount } = render(<Scanner onText={onText} onProblem={() => {}} env={jsqrEnv("x")} />);
      await waitFor(() => expect(onText).toHaveBeenCalled());
      const canvas = container.querySelector("canvas")!;
      unmount();
      expect(canvas.width).toBe(0);
    });
  });

  describe("the page is hidden", () => {
    it("visibilitychange to hidden stops the camera and offers a restart", async () => {
      render(<Scanner onText={() => false} onProblem={() => {}} env={jsqrEnv(null)} />);
      await settle();
      expect(track.stop).not.toHaveBeenCalled();
      hide();
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Restart the camera" })).toBeTruthy();
    });
    it("pagehide does the same", async () => {
      render(<Scanner onText={() => false} onProblem={() => {}} env={jsqrEnv(null)} />);
      await settle();
      act(() => void window.dispatchEvent(new Event("pagehide")));
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Restart the camera" })).toBeTruthy();
    });
    it("visible again does not restart it by itself; the button does", async () => {
      render(<Scanner onText={() => false} onProblem={() => {}} env={jsqrEnv(null)} />);
      await settle();
      hide();
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      await settle();
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Restart the camera" }));
      await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("button", { name: "Restart the camera" })).toBeNull();
    });
    it("hidden while the camera is still starting: it is released when it arrives", async () => {
      let give!: (s: unknown) => void;
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => (give = r)));
      render(<Scanner onText={() => false} onProblem={() => {}} env={jsqrEnv(null)} />);
      hide();
      await act(async () => give({ getTracks: () => [track] }));
      await settle();
      expect(track.stop).toHaveBeenCalled();
    });
  });
});
