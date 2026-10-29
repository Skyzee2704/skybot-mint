import { describe, expect, it, vi } from "vitest";
import { telegramBotLinkProps, telegramBotUsername } from "../../web/lib/telegram.js";

describe("web Telegram bot link", () => {
  it("accepts a valid username (with or without @) and hides otherwise", () => {
    expect(telegramBotUsername("SkymintsBOT")).toBe("SkymintsBOT");
    expect(telegramBotUsername("@SkymintsBOT")).toBe("SkymintsBOT");
    expect(telegramBotUsername("")).toBeNull();
    expect(telegramBotUsername(undefined)).toBeNull();
    expect(telegramBotUsername("bad name/../x")).toBeNull();
  });

  it("opens a new tab on the web and uses openTelegramLink inside the Mini App", () => {
    const web = telegramBotLinkProps("SkymintsBOT", null);
    expect(web).toMatchObject({ href: "https://t.me/SkymintsBOT", target: "_blank" });
    const pd = vi.fn();
    web.onClick({ preventDefault: pd });
    expect(pd).not.toHaveBeenCalled();

    const open = vi.fn();
    const mini = telegramBotLinkProps("SkymintsBOT", { openTelegramLink: open } as any);
    mini.onClick({ preventDefault: pd });
    expect(pd).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://t.me/SkymintsBOT");
  });
});
