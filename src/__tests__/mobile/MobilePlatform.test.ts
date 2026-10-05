import { describe, expect, it } from "vitest";
import { appleTouchDevice } from "../../../mobile-web/src/platform";

describe("appleTouchDevice", () => {
  it("knows an iPad that reports a Mac's user agent by its touch points", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    expect(appleTouchDevice({ userAgent: mac, maxTouchPoints: 5 })).toBe("iPad");
    expect(appleTouchDevice({ userAgent: mac, maxTouchPoints: 0 })).toBeNull();
  });

  it("tells an iPhone and an older iPad apart, and nothing else is one", () => {
    expect(appleTouchDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 })).toBe("iPhone");
    expect(appleTouchDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X)", maxTouchPoints: 5 })).toBe("iPad");
    expect(appleTouchDevice({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)", maxTouchPoints: 5 })).toBeNull();
  });
});
