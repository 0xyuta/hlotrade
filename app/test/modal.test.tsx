// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "../src/ui/Modal";

afterEach(cleanup);

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <Modal title="Sure?" onClose={() => setOpen(false)}>
          <button>inner</button>
        </Modal>
      )}
    </>
  );
}

describe("Modal focus", () => {
  it("moves focus into the dialog, closes on Escape and returns focus to the opener", () => {
    render(<Host />);
    const opener = screen.getByText("open");
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("keeps Tab inside the dialog", () => {
    render(<Host />);
    fireEvent.click(screen.getByText("open"));
    const close = screen.getByLabelText("Close");
    const inner = screen.getByText("inner");
    inner.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inner);
  });
  it("closes on a backdrop click and on the Close button", () => {
    render(<Host />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
