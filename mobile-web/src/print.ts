import { appleTouchDevice, isInstalledApp } from "./platform";

/** What a viewer prints: a text, or pictures one per sheet (a picture, or a
 * PDF's pages drawn by the sealed frame). */
export type PrintContent = { text: string } | { pictures: string[] };

/** The widest a PDF page is drawn for paper: about 190 dpi across A4, under
 * the frame's own cap. */
export const PRINT_WIDTH = 1600;
/** The most pages a PDF prints from the phone; each is held as a picture
 * while the print dialog is up. A longer one is saved and printed from the
 * phone's own PDF app. */
export const MAX_PRINT_PAGES = 120;

/**
 * Whether the viewer offers Print. The Home Screen app on an iPhone or iPad
 * has no working `window.print()` — there the share sheet's Print does it.
 */
export function canPrint(): boolean {
  if (typeof window === "undefined" || typeof window.print !== "function") return false;
  return !(appleTouchDevice() !== null && isInstalledApp());
}

/** The sheet being printed, until the dialog closes or another print starts. */
let pending: (() => void) | null = null;

/** Takes away what the last print put up, if the dialog never said it closed. */
export function clearPrint() {
  pending?.();
}

/**
 * Prints `content` through the browser's own dialog. It is laid out in a
 * `.print-root` beside the app, which print CSS shows alone (`style.css`);
 * the page's title names the job, so a "Save as PDF" is named after the
 * file. Everything goes once the dialog reports it closed.
 */
export async function printContent(content: PrintContent, title: string): Promise<void> {
  clearPrint();
  const root = document.createElement("div");
  root.className = "print-root";
  if ("text" in content) {
    const pre = document.createElement("pre");
    pre.textContent = content.text;
    root.append(pre);
  } else {
    for (const src of content.pictures) {
      const page = document.createElement("div");
      page.className = "print-page";
      const img = document.createElement("img");
      img.alt = "";
      img.src = src;
      page.append(img);
      root.append(page);
    }
  }
  document.body.append(root);
  const was = document.title;
  const done = () => {
    window.removeEventListener("afterprint", done);
    root.remove();
    document.title = was;
    if (pending === done) pending = null;
  };
  pending = done;
  // Every picture decoded first, or the dialog's preview shows blanks.
  await Promise.all([...root.querySelectorAll("img")].map((img) => (typeof img.decode === "function" ? img.decode().catch(() => undefined) : undefined)));
  if (pending !== done) return;
  document.title = title;
  window.addEventListener("afterprint", done);
  window.print();
}

/** A page the frame drew, as a picture the page may show: the app's CSP
 * takes `data:` images, not `blob:`. The bitmap is closed. */
export async function bitmapDataUrl(bitmap: ImageBitmap): Promise<string> {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no_canvas");
    // A page with no background of its own prints on white, not black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("no_png");
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
      reader.readAsDataURL(blob);
    });
  } finally {
    bitmap.close();
  }
}
