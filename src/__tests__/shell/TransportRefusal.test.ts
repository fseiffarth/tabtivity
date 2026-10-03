/**
 * Final review B5: every refusal the browser transport passes on reads as one
 * sentence in the user's language, and keeps the wire fields callers branch on.
 */
import { describe, expect, it } from "vitest";
import { asRefusal, isRefusal, RefusalError, refusalText } from "../../lib/transport/refusal";
import { en } from "../../lib/i18n";

describe("transport refusals", () => {
  it("names each refusal code in words", () => {
    expect(refusalText({ code: "admin" })).toBe(en["transport.refusal.admin"]);
    expect(refusalText({ code: "off", reason: "whole-document-save" })).toBe(en["transport.refusal.off.wholeDocumentSave"]);
    expect(refusalText({ code: "off", reason: "something-new" })).toBe(en["transport.refusal.off"]);
    expect(refusalText({ code: "model-not-allowed", model: "llama3" })).toContain("llama3");
    expect(refusalText({ code: "feature-off", feature: "mail" })).toBe(en["transport.refusal.featureOff"]);
  });

  it("turns a refusal into an Error that reads as its sentence and leaves other errors alone", () => {
    const refused = asRefusal({ code: "off", reason: "whole-document-save" }, "save_boxes");
    expect(refused).toBeInstanceOf(RefusalError);
    expect(String(refused)).toBe(en["transport.refusal.off.wholeDocumentSave"]);
    expect(refused).toMatchObject({ code: "off", reason: "whole-document-save", command: "save_boxes" });
    expect(asRefusal("a command's own error")).toBe("a command's own error");
    expect(isRefusal({ code: "something-else" })).toBe(false);
    const own = new Error("x");
    expect(asRefusal(own)).toBe(own);
  });
});
