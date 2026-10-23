import { describe, expect, it } from "vitest";
import { speechOutputSupported } from "../../../mobile-web/src/speechOutput";
import { BRAND } from "../../lib/brand";

describe(`${BRAND.display} Mobile read-aloud`, () => {
  it("is absent where the browser cannot speak", () => {
    expect(speechOutputSupported({} as Window)).toBe(false);
    expect(speechOutputSupported({ speechSynthesis: {}, SpeechSynthesisUtterance: class {} } as unknown as Window)).toBe(true);
  });
});
