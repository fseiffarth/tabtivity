import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { storageKey } from "../../lib/brand";
import { ChevronDownIcon, ChevronRightIcon } from "../common/icons/Icon";

export function GitFoldSection({ title, meta, preferenceKey, untested, children, ...section }: ComponentPropsWithoutRef<"section"> & {
  title: string;
  meta?: ReactNode;
  preferenceKey: string;
  untested: ReactNode;
}) {
  const key = storageKey(preferenceKey);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      if (next) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch { /* ignore storage failures */ }
  }

  return (
    <section {...section}>
      <button type="button" className="sp-head" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <span>{title}</span>
        {meta != null && <span className="sp-head-meta">{meta}</span>}
        {untested}
      </button>
      {open && children}
    </section>
  );
}
