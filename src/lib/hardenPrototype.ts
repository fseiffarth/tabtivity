/**
 * Freeze `Object.prototype` for Tabtivity's own windows (#159) — the guard Tauri's
 * `freezePrototype` offers, done here instead for two measured reasons:
 *
 * - Tauri injects that freeze into *every* webview, the in-app browser's
 *   `browser-*` live pages included, where it would break arbitrary websites.
 *   Called from `main.tsx`, this runs only in the app's own bundle.
 * - A bare `Object.freeze(Object.prototype)` breaks pdf-lib: with every suite
 *   run under it, PDF notes/redaction/save and deck export fail on
 *   `PDFHeader.prototype.toString = …` / `.constructor = …` / `.valueOf = …`.
 *   That is the "override mistake": assigning a property an object inherits
 *   from a frozen prototype throws, even though it would only create an own
 *   property. So each inherited method becomes an accessor first — its getter
 *   returns the original, its setter defines an own property on the target —
 *   the same override taming Hardened JavaScript (SES) uses. Libraries keep
 *   overriding on their own objects; nothing can add to or replace a
 *   property of the prototype itself, which is what prototype pollution needs.
 */
export function hardenPrototype(proto: object = Object.prototype): void {
  if (Object.isFrozen(proto)) return;
  for (const key of Reflect.ownKeys(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    // `__proto__` is already an accessor, and the rest are data properties.
    if (!desc || !("value" in desc)) continue;
    const value: unknown = desc.value;
    Object.defineProperty(proto, key, {
      get() {
        return value;
      },
      set(this: unknown, next: unknown) {
        if (this === proto) {
          throw new TypeError(`Object.prototype.${String(key)} is read-only`);
        }
        // Assigning to a primitive's property stores nothing, as before.
        if (this === null || (typeof this !== "object" && typeof this !== "function")) return;
        Object.defineProperty(this, key, {
          value: next,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
      enumerable: desc.enumerable,
      configurable: false,
    });
  }
  Object.freeze(proto);
}
