import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OutboxPost } from "../../../mobile-web/src/components/OutboxPost";
import { AnswerAlbum } from "../../../mobile-web/src/components/AnswerFiles";
import { viewerFileUrl } from "../../../mobile-web/src/api";
import { useThumb } from "../../../mobile-web/src/thumbs";

vi.mock("../../../mobile-web/src/thumbs", () => ({ useThumb: vi.fn(() => "blob:pdf-cover") }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const pdf = { name: "report.pdf", kind: "application/pdf", size: 100, modified: 100, ref: "sealed", file_row: { name: "report.pdf", kind: "application/pdf", size: 100, modified: 100, token: "sealed", place: "" } };

it("shows a sent PDF's first page using its outbox route and keeps tap-to-open", () => {
  const open = vi.fn();
  const scope = { project: "p1" };
  render(<OutboxPost scope={scope} post={{ key: pdf.name, files: [pdf] }} onOpen={open} />);
  expect(document.querySelector(".pdf-file-cover img")?.getAttribute("src")).toBe("blob:pdf-cover");
  expect(vi.mocked(useThumb).mock.calls[0][6]).toBe(viewerFileUrl(scope, pdf));
  fireEvent.click(screen.getByRole("button", { name: /report.pdf/ }));
  expect(open).toHaveBeenCalledWith(pdf);
});

it("shows a named answer PDF using the sealed project route", () => {
  const open = vi.fn();
  render(<AnswerAlbum text="report.pdf" files={{ project: "p1", named: new Map([[pdf.name, pdf]]), links: new Map(), sent: new Set(), open }} />);
  expect(document.querySelector(".pdf-file-cover img")).not.toBeNull();
  expect(vi.mocked(useThumb).mock.calls[0][6]).toBe(viewerFileUrl({ files: "p1" }, pdf));
  fireEvent.click(screen.getByRole("button", { name: /report.pdf/ }));
  expect(open).toHaveBeenCalledWith(pdf);
});

it("keeps a sent PDF openable when no thumbnail can be rendered", () => {
  vi.mocked(useThumb).mockReturnValueOnce(null);
  const open = vi.fn();
  render(<OutboxPost scope={{ tab: "t1" }} post={{ key: pdf.name, files: [pdf] }} onOpen={open} />);
  expect(screen.getByText("PDF")).toBeTruthy();
  expect(document.querySelector(".pdf-file-cover img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /report.pdf/ }));
  expect(open).toHaveBeenCalledWith(pdf);
});
