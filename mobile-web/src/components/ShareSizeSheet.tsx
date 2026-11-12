import { useT } from "../../../src/lib/i18n";
import { formatBytes } from "../../../src/lib/formatBytes";
import { sentName, type OutboxFile } from "../api";
import { ConfirmSheet } from "./ConfirmSheet";

/** The question before sharing a file (or several) past the share limit:
 * the phone holds all of it in memory first, which can be slow or fail.
 * Never zipped — yes shares the files as they are. */
export function ShareSizeSheet({ files, onShare, onClose }: {
  files: readonly OutboxFile[] | OutboxFile | null;
  onShare: () => void;
  onClose: () => void;
}) {
  const t = useT();
  if (!files) return null;
  const list = Array.isArray(files) ? files as readonly OutboxFile[] : [files as OutboxFile];
  const size = formatBytes(list.reduce((sum, file) => sum + file.size, 0));
  const title = list.length === 1
    ? t("mobile.outbox.shareBig.one", { name: sentName(list[0]), size })
    : t("mobile.outbox.shareBig.many", { count: list.length, size });
  return <ConfirmSheet
    confirm={{ title, note: t("mobile.outbox.shareBig.note"), label: t("mobile.outbox.shareBig.yes"), run: onShare }}
    busy={false}
    onClose={onClose}
  />;
}
