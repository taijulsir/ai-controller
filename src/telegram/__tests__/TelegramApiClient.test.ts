import { afterEach, describe, expect, it, vi } from "vitest";
import type { IConfigService } from "../../config/interfaces";
import type { TelegramConfig } from "../../config/types";
import { TelegramApiClient } from "../TelegramApiClient";
import type { OutgoingMessage } from "../types";

function configService(): IConfigService {
  const telegramConfig = {
    telegram: { enabled: true },
    bot: { token: "test-token" },
    security: { allowed_users: [] },
  } as unknown as TelegramConfig;

  return {
    getControllerConfig: () => { throw new Error("not used"); },
    getClaudeConfig: () => { throw new Error("not used"); },
    getGithubConfig: () => { throw new Error("not used"); },
    getTelegramConfig: () => telegramConfig,
    getRepositories: () => [],
    reload: () => {},
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TelegramApiClient.sendMessage", () => {
  it("sends a well-formed HTML message as-is", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramApiClient(configService());
    const message: OutgoingMessage = { chatId: 1, text: "<b>Hello</b>" };
    await client.sendMessage(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toBe("<b>Hello</b>");
  });

  it("falls back to plain text instead of throwing when Telegram rejects the HTML", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: Can't find end tag corresponding to start tag \"pre\"" }), { status: 400 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramApiClient(configService());
    const message: OutgoingMessage = { chatId: 1, text: "<pre>unbalanced" };
    await expect(client.sendMessage(message)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(fallbackBody.parse_mode).toBeUndefined();
    expect(fallbackBody.text).toBe("unbalanced");
  });

  it("still throws for non-HTML-parse 400s (e.g. an actually invalid chat id)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramApiClient(configService());
    await expect(client.sendMessage({ chatId: 1, text: "hello" })).rejects.toThrow(/chat not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("splits a long diff without ever sending an unbalanced <pre> chunk", async () => {
    const seenTexts: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      seenTexts.push(body.text as string);
      return jsonResponse(200, { ok: true, result: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramApiClient(configService());
    const diffLines = Array.from({ length: 400 }, (_, i) => `+line ${i} some diff content padding`);
    const text = `<pre>${diffLines.join("\n")}</pre>`;
    await client.sendMessage({ chatId: 1, text });

    expect(seenTexts.length).toBeGreaterThan(1);
    for (const sent of seenTexts) {
      const opens = (sent.match(/<pre>/g) ?? []).length;
      const closes = (sent.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});
