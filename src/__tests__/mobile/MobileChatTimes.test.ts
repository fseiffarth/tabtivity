import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { chatDayLabel, chatMoment, chatTime, dayOpeners } from "../../../mobile-web/src/terminal/chatTimes";
import { pendingPrompt, withPending } from "../../../mobile-web/src/terminal/pendingPrompts";
import { transcriptTurns } from "../../../mobile-web/src/terminal/transcriptTurns";
import { BRAND } from "../../lib/brand";

const labels = { today: "Today", yesterday: "Yesterday" };
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe(`${BRAND.display} Mobile chat times`, () => {
  it("reads a record's stamp, and nothing from a missing or unreadable one", () => {
    expect(chatMoment("2026-09-29T10:05:00Z")?.toISOString()).toBe("2026-09-29T10:05:00.000Z");
    expect(chatMoment(undefined)).toBeNull();
    expect(chatMoment("10:00:00")).toBeNull();
  });

  it("stamps a bubble with its clock time", () => {
    expect(chatTime(local(2026, 9, 29, 14, 5))).toMatch(/14:05|2:05/);
  });

  it("follows the desktop's clock when it is handed one, whatever the locale", () => {
    expect(chatTime(local(2026, 9, 29, 14, 5), true)).toBe("14:05");
    expect(chatTime(local(2026, 9, 29, 14, 5), false)).toMatch(/02:05|2:05/);
    expect(chatTime(local(2026, 9, 29, 14, 5), false)).not.toMatch(/14/);
  });

  it("names the day as a messenger does", () => {
    const now = local(2026, 9, 29, 9);
    expect(chatDayLabel(local(2026, 9, 29, 0, 1), now, labels)).toBe("Today");
    expect(chatDayLabel(local(2026, 9, 28, 23, 59), now, labels)).toBe("Yesterday");
    expect(chatDayLabel(local(2026, 9, 25), now, labels)).toBe(local(2026, 9, 25).toLocaleDateString([], { weekday: "long" }));
    expect(chatDayLabel(local(2026, 9, 1), now, labels)).not.toMatch(/2026/);
    expect(chatDayLabel(local(2025, 12, 31), now, labels)).toMatch(/2025/);
  });

  it("opens a day chip only where a later day starts", () => {
    const at = (d: number, h: number) => local(2026, 9, d, h).toISOString();
    expect([...dayOpeners([at(27, 10), undefined, at(27, 11), at(28, 9), at(27, 23), at(28, 10), at(29, 1)])]).toEqual([0, 3, 6]);
    expect(dayOpeners([undefined, "garbage"]).size).toBe(0);
  });

  it("times a prompt still pending by when the phone sent it, not by its place", () => {
    const before: TranscriptEntry[] = [{ kind: "answer", text: "Done.", at: "2026-09-28T10:00:00Z" }];
    const sent = pendingPrompt(1, "next", before);
    const [, pending] = transcriptTurns(withPending(before, [sent]));
    expect(pending.pending).toBe(1);
    expect(pending.stamp).toBe(sent.sentAt);
    expect(transcriptTurns(before)[0].stamp).toBe("2026-09-28T10:00:00Z");
  });
});
