import { describe, expect, it } from "vitest";
import { alertRequests } from "../src/alerts.js";

describe("alertRequests", () => {
  it("targets webhook and Telegram when configured, never logging the Telegram token", () => {
    const r = alertRequests({ ALERT_WEBHOOK_URL: "https://hook", TELEGRAM_BOT_TOKEN: "T0K", TELEGRAM_CHAT_ID: "42" }, "hi");
    expect(r.map((x) => x.label)).toEqual(["webhook", "telegram"]);
    expect(r[0].body).toEqual({ text: "hi", content: "hi" });
    expect(r[1].url).toBe("https://api.telegram.org/botT0K/sendMessage");
    expect(r[1].body).toMatchObject({ chat_id: "42", text: "hi" });
    expect(r[1].label).not.toContain("T0K");
  });
  it("is empty without config", () => {
    expect(alertRequests({}, "x")).toEqual([]);
  });
  it("needs both the Telegram token and chat id", () => {
    expect(alertRequests({ TELEGRAM_BOT_TOKEN: "T0K" }, "x")).toEqual([]);
    expect(alertRequests({ TELEGRAM_CHAT_ID: "42" }, "x")).toEqual([]);
  });
  it("truncates to each channel's limit", () => {
    const long = "a".repeat(5000);
    const r = alertRequests({ ALERT_WEBHOOK_URL: "https://hook", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "1" }, long);
    expect((r[0].body.content as string).length).toBe(1990);
    expect((r[1].body.text as string).length).toBe(4000);
  });
});
