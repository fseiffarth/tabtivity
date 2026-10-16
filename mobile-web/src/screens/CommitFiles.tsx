import { useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import type { ChatUncommitted, UncommittedFile } from "../api";

/** Rows shown before "N more" opens the rest. */
export const COMMIT_FILES_SHOWN = 8;

const STATUS: Record<UncommittedFile["status"], TranslationKey> = {
  modified: "mobile.commit.fileModified",
  added: "mobile.commit.fileAdded",
  deleted: "mobile.commit.fileDeleted",
};

/**
 * The Commit sheet's list of what this chat changed and has not committed,
 * in the Git sheet's rows: the file under its worktree's name, its kind of
 * change beside it. Nothing for a chat whose edits are not read.
 */
export function CommitFiles({ uncommitted }: { uncommitted: ChatUncommitted | null }) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (!uncommitted?.available) return null;
  const { files, total } = uncommitted;
  const shown = all ? files : files.slice(0, COMMIT_FILES_SHOWN);
  const hidden = total - shown.length;
  return <div className="commit-files">
    <h3 className="git-section">
      {total === 0 ? t("mobile.commit.uncommittedNone") : t(total === 1 ? "mobile.commit.uncommittedOne" : "mobile.commit.uncommitted", { count: total })}
      {isUntested("mobile.composer.uncommitted") && <small className="untested">{t("mobile.focus.untested")}</small>}
    </h3>
    {shown.length > 0 && <ul className="git-rows">
      {shown.map((file) => <li key={`${file.worktree?.label ?? ""}\u0000${file.path}`}>
        {file.worktree && <small>{file.worktree.branch ? `${file.worktree.label} — ⎇ ${file.worktree.branch}` : file.worktree.label}</small>}
        <span><code>{file.path}</code><em className="git-quiet"> · {t(STATUS[file.status])}</em></span>
      </li>)}
      {hidden > 0 && <li className="git-more">
        {/* Past what the host sends, more cannot be opened here. */}
        {!all && files.length > shown.length
          ? <button type="button" onClick={() => setAll(true)}>{t("mobile.gitSheet.more", { count: hidden })}</button>
          : <span>{t("mobile.gitSheet.more", { count: hidden })}</span>}
      </li>}
    </ul>}
    <p className="sheet-note">{t("mobile.commit.uncommittedFloor")}</p>
  </div>;
}
