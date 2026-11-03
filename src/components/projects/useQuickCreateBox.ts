import { useCallback, type ReactNode } from "react";
import { useDialogs } from "../common/PromptDialogs";
import { useT } from "../../lib/i18n";
import {
  BoxNameError,
  boxNameProblem,
  defaultBoxName,
  MAX_BOX_NAME_CHARS,
  useBoxesStore,
  type BoxNameProblem,
} from "../../stores/boxes";
import { useBoxSliceStore } from "../../stores/boxSlice";
import { useProjectsStore } from "../../stores/projects";
import { usePillSelectionStore } from "../../stores/drag/pillSelection";
import type { ProjectBox } from "../../types";

/**
 * The localized text of a refused box name, for an inline error (a prompt's
 * `validate`, a rename field, the box sheet). `check(name, ownId?)` is `null`
 * when the name may be written; pass the box's own id when renaming so it may
 * keep its spelling. `messageOf` also maps a thrown {@link BoxNameError}.
 * Apply it to a name that differs from the stored one only (the sheet's diffed
 * save skips the rest), so a legacy duplicate never blocks an unrelated save.
 */
export function useBoxNameCheck() {
  const t = useT();
  const text = useCallback(
    (problem: BoxNameProblem): string =>
      problem === "empty"
        ? t("boxName.empty")
        : problem === "tooLong"
          ? t("boxName.tooLong", { max: MAX_BOX_NAME_CHARS })
          : problem === "invalid"
            ? t("boxName.invalid")
            : t("boxName.taken"),
    [t],
  );
  const check = useCallback(
    (name: string, ownId?: string): string | null => {
      const problem = boxNameProblem(name, useBoxesStore.getState().boxes, ownId);
      return problem ? text(problem) : null;
    },
    [text],
  );
  /** The shown reason for a failed write: the name's own, else the error's text. */
  const messageOf = useCallback(
    (error: unknown): string =>
      error instanceof BoxNameError ? text(error.problem) : error instanceof Error ? error.message : String(error),
    [text],
  );
  return { check, text, messageOf };
}

/** The next free "Box N" in the user's language, from the boxes as they are now. */
export function useDefaultBoxName(): () => string {
  const t = useT();
  return useCallback(
    () => defaultBoxName(useBoxesStore.getState().boxes, (n) => t("boxName.default", { n })),
    [t],
  );
}

export interface QuickCreateBox {
  /**
   * Ask for a name (pre-filled with the next free "Box N", selected, Enter
   * confirms), create the box holding `memberIds`, and enter it: the slice is
   * selected and the box scope opened (`boxSlice.selectBox`). Resolves to the
   * new box, or `null` when the prompt was dismissed. A refused name (empty,
   * taken, too long) stays on the prompt with the reason; so does a failed
   * write, with the typed name kept. A project selection (Ctrl-click pills) is
   * cleared once the box exists.
   */
  quickCreateBox: (memberIds?: string[]) => Promise<ProjectBox | null>;
  /** The prompt's host: render it once next to whatever calls `quickCreateBox`
   *  (`promptText` is a hook, so a store cannot ask). */
  dialogs: ReactNode;
}

/**
 * The one door every "new box" gesture goes through (the "+" menu row, "Box
 * these…", "New box with X…", the ghost pill, the palette): name it, Enter, you
 * are in. Membership is edited afterwards, where you are.
 */
export function useQuickCreateBox(): QuickCreateBox {
  const t = useT();
  const { promptText, dialogs } = useDialogs();
  const { check } = useBoxNameCheck();
  const defaultName = useDefaultBoxName();

  const quickCreateBox = useCallback(
    async (memberIds: string[] = []): Promise<ProjectBox | null> => {
      const ids = [...new Set(memberIds)];
      const projects = useProjectsStore.getState().projects;
      const names = ids.map((id) => projects.find((p) => p.id === id)?.name).filter((n): n is string => !!n);
      const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");
      let created: ProjectBox | null = null;
      const answered = await promptText(
        {
          title: t("boxName.promptTitle"),
          body: names.length > 0 ? t("boxName.promptMembers", { names: shown }) : undefined,
          label: t("boxName.promptLabel"),
          initial: defaultName(),
          confirmLabel: t("boxName.promptConfirm"),
          validate: (value) => check(value),
        },
        async (name) => {
          created = await useBoxesStore.getState().createBoxQuick({ name, memberIds: ids });
        },
      );
      if (answered === null || !created) return null;
      const box: ProjectBox = created;
      usePillSelectionStore.getState().clear();
      await useBoxSliceStore.getState().selectBox(box.id);
      return box;
    },
    [t, promptText, check, defaultName],
  );

  return { quickCreateBox, dialogs };
}
