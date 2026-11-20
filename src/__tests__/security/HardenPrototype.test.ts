import { describe, it, expect } from "vitest";
import { hardenPrototype } from "../../lib/hardenPrototype";

/** A stand-in for `Object.prototype`, hardened in its place so the runner's
 *  own is never frozen. Carries the methods pdf-lib overrides. Test modules
 *  are strict, as bundles are, so a refused write throws. */
function hardenedProto() {
  const proto: Record<string, unknown> = Object.create(null);
  proto.toString = () => "[base]";
  proto.valueOf = function () {
    return this;
  };
  proto.constructor = Object;
  hardenPrototype(proto);
  return proto;
}

describe("hardenPrototype (#159)", () => {
  it("refuses prototype pollution: no new keys, no replaced methods", () => {
    const proto = hardenedProto();
    expect(Object.isFrozen(proto)).toBe(true);
    expect(() => {
      proto.polluted = 1;
    }).toThrow(TypeError);
    expect(() => {
      proto.toString = () => "evil";
    }).toThrow(/read-only/);
    expect(() => Object.defineProperty(proto, "toString", { value: 1 })).toThrow(TypeError);
    const child = Object.create(proto) as Record<string, unknown>;
    expect(child.polluted).toBeUndefined();
    expect((child.toString as () => string)()).toBe("[base]");
  });

  it("keeps the overrides pdf-lib makes on its own objects (the override mistake)", () => {
    const proto = hardenedProto();
    // The shapes that failed under a bare freeze: a class prototype's
    // toString/constructor/valueOf assigned rather than defined.
    function PDFHeader() {}
    const headerProto = Object.create(proto) as Record<string, unknown>;
    headerProto.constructor = PDFHeader;
    headerProto.toString = () => "%PDF-1.7";
    const header = Object.create(headerProto) as Record<string, unknown>;
    expect((header.toString as () => string)()).toBe("%PDF-1.7");
    expect(header.constructor).toBe(PDFHeader);
    const m = Object.create(proto) as Record<string, unknown>;
    m.valueOf = () => 42;
    expect((m.valueOf as () => number)()).toBe(42);
    // The override is an ordinary own, enumerable, writable property.
    expect(Object.keys(m)).toEqual(["valueOf"]);
    m.valueOf = () => 43;
    expect((m.valueOf as () => number)()).toBe(43);
    // Objects that never overrode still see the originals.
    expect((Object.create(proto).toString as () => string)()).toBe("[base]");
  });

  it("stores nothing when the setter is reached with a primitive receiver", () => {
    const proto = hardenedProto();
    const setter = Object.getOwnPropertyDescriptor(proto, "toString")?.set;
    expect(setter).toBeTypeOf("function");
    const store = setter as (this: unknown, next: unknown) => void;
    for (const receiver of ["a", 1, true, null, undefined]) {
      // Reaching `defineProperty` on a primitive would throw a TypeError.
      expect(() => store.call(receiver, () => "x"), String(receiver)).not.toThrow();
    }
    // Nothing was stored on the prototype either: its own getter still answers.
    expect((proto.toString as () => string)()).toBe("[base]");
    expect(Object.getOwnPropertyDescriptor(proto, "toString")?.set).toBe(setter);
  });

  it("is idempotent", () => {
    const proto = hardenedProto();
    expect(() => hardenPrototype(proto)).not.toThrow();
  });
});
