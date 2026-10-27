import { lazy } from "react";

// The five heavyweight leaf viewers are code-split (§5.1 startup size): a
// static import here would parse pdfjs-dist + pdf-lib + fontkit (PdfView,
// DeckView) and the table/notebook/sqlite machinery at every window's launch.
// `lazy` defers each to its first render behind the existing dispatch switch;
// the Suspense boundaries sit around the two render sites below.
export const TableView = lazy(() => import("../TableView").then((m) => ({ default: m.TableView })));
export const NotebookView = lazy(() => import("../NotebookView").then((m) => ({ default: m.NotebookView })));
export const SqliteView = lazy(() => import("../SqliteView").then((m) => ({ default: m.SqliteView })));
export const PdfView = lazy(() => import("../pdf/PdfViewer").then((m) => ({ default: m.PdfView })));
export const DeckView = lazy(() => import("../deck/DeckView").then((m) => ({ default: m.DeckView })));
// Perf plan §6: the rest of the viewers a plain text/markdown/code tab never
// shows. The top-level ones render under the pane's own `<Suspense>` (below);
// the nested ones (a text tab's tree/grid/card preview half, the markdown link
// graph, the image annotator) each get a local boundary at their site, so a
// first switch to one never blanks the editor around it.
export const GifView = lazy(() => import("../GifView").then((m) => ({ default: m.GifView })));
export const SyncMergeView = lazy(() => import("../SyncMergeView").then((m) => ({ default: m.SyncMergeView })));
export const GitMergeView = lazy(() => import("../GitMergeView").then((m) => ({ default: m.GitMergeView })));
export const OdtView = lazy(() => import("../OdtView").then((m) => ({ default: m.OdtView })));
export const MediaView = lazy(() => import("../MediaView").then((m) => ({ default: m.MediaView })));
export const YamlTree = lazy(() => import("../YamlTree").then((m) => ({ default: m.YamlTree })));
export const YamlGrid = lazy(() => import("../YamlGrid").then((m) => ({ default: m.YamlGrid })));
export const BibCards = lazy(() => import("../BibCards").then((m) => ({ default: m.BibCards })));
export const MdGraphView = lazy(() => import("../MdGraphView").then((m) => ({ default: m.MdGraphView })));
export const ImageAnnotator = lazy(() => import("../ImageAnnotator").then((m) => ({ default: m.ImageAnnotator })));
