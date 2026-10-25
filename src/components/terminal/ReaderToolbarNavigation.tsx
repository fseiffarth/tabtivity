import { useT } from "../../lib/i18n";
import { Dropdown } from "../common/Dropdown";

export interface ReaderToolbarFile {
  path: string;
  label: string;
  open: () => void;
}

/** The top bar's Files menu: the files this conversation's resolved links and
 * inbox references name; absent while there are none. Moving the agent to
 * another git worktree stays the facts row's ⎇ chip. */
export function ReaderToolbarNavigation({ files }: { files: readonly ReaderToolbarFile[] }) {
  const t = useT();
  if (files.length === 0) return null;
  return <Dropdown
    className="reader-toolbar-dropdown"
    value=""
    placeholder={t("terminal.reader.files", { count: files.length })}
    ariaLabel={t("terminal.reader.files", { count: files.length })}
    options={files.map((file) => ({ value: file.path, label: file.label }))}
    onChange={(path) => files.find((file) => file.path === path)?.open()}
  />;
}
