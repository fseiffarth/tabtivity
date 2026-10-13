import { describe, expect, it } from "vitest";
import { pairingUrl } from "../../components/mobile/AddDevice";

describe("Add device link", () => {
  it("puts the code in the fragment of the private origin", () => {
    expect(pairingUrl("https://desk.example.ts.net", "12345678")).toBe("https://desk.example.ts.net/#pair=12345678");
    expect(pairingUrl("https://desk.example.ts.net:8443/", "alice:12345678")).toBe("https://desk.example.ts.net:8443/#pair=alice%3A12345678");
  });
});
