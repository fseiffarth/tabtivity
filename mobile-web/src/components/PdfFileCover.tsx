import { useRef } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { viewerFileUrl, type OutboxFile, type ViewerScope } from "../api";
import { useThumb } from "../thumbs";

/** The same bounded, visibility-gated first-page renderer as the library,
 * reading the file through its own route (including outbox and inbox copies). */
export function PdfFileCover({ scope, file }: { scope: ViewerScope; file: OutboxFile }) {
  const t = useT();
  const cover = useRef<HTMLSpanElement>(null);
  const project = "files" in scope ? scope.files : "project" in scope ? scope.project : "";
  const place = `\u0000pdf-card/${JSON.stringify(scope)}`;
  const thumb = useThumb(cover, project, { ...file, token: file.ref ?? "" }, place, true, undefined, viewerFileUrl(scope, file));
  return <span ref={cover} className="pdf-file-cover">
    {thumb ? <img src={thumb} alt="" /> : <b aria-hidden="true">PDF</b>}
    {isUntested("mobile.pdf.fileCovers") && <small>{t("mobile.outbox.untested")}</small>}
  </span>;
}
