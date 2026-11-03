import { useEffect, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { tabColorCss } from "../../../src/lib/theme/tabColors";
import { isUntested } from "../../../src/lib/untested";
import { goBack } from "../backStack";
import { ApiError, api, type OutboxFile, type ProjectDetail, type ViewerScope } from "../api";
import { onFavorites, onFolderColors, readFavoritePlaces, rememberFilesPlace, removeFavorite, savedPlace, type FavoritePlace, type FilesSaved } from "../filesPlace";
import { FileGlyph, FilesLibrary, asViewerFile, failureKey, lookUpSaved, noteFileOpened } from "./FilesLibrary";
import { OptionSheet } from "./OptionSheet";
import { OutboxViewer } from "./OutboxViewer";

type Picked = { place: FavoritePlace; item: FilesSaved };

const staleKey = ({ place, item }: Picked) => `${place.placeId}\n${savedPlace(item)}`;

/**
 * Home's Favorites segment: what was starred in any project's library, grouped
 * by project, a remote project's side as a group of its own. Starring stays
 * the library's (an item's menu); this page lists, opens and unstars.
 *
 * The lists are this phone's own (`filesPlace.ts`), so the page draws them
 * with no link; the desktop is asked only for each project's name, and whether
 * it is still shared. A file opens by its folder's listing, as in the library,
 * so nothing here decides what a refusal means: the desktop's switch being
 * off, a host not connected or a project no longer shared say so at the tap.
 * A folder opens the library standing in it. Mark up needs a tab to send to,
 * so a file opened here is only viewed; a PDF's card on the project screen,
 * which opening it makes, offers it.
 */
export function FavoritesPage() {
  const t = useT();
  const [places, setPlaces] = useState(() => readFavoritePlaces());
  /** Each project's detail, `gone` when no longer shared, `failed` when the
   * read failed otherwise (its group is named "Project"). */
  const [projects, setProjects] = useState<Record<string, ProjectDetail | "gone" | "failed">>({});
  const [viewer, setViewer] = useState<{ place: FavoritePlace; file: OutboxFile } | null>(null);
  const [library, setLibrary] = useState<FavoritePlace | null>(null);
  const [sheet, setSheet] = useState<(Picked & { gone: boolean }) | null>(null);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  /** Favorites found moved or deleted: dimmed. */
  const [stale, setStale] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const reread = () => setPlaces(readFavoritePlaces());
    const offs = [onFavorites(reread), onFolderColors(reread)];
    return () => offs.forEach((off) => off());
  }, []);

  const ids = [...new Set(places.map((place) => place.projectId))].join("\n");
  useEffect(() => {
    const controller = new AbortController();
    for (const id of ids.split("\n").filter(Boolean)) {
      void api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`, { signal: controller.signal }).then(
        (detail) => setProjects((known) => ({ ...known, [id]: detail })),
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          const gone = reason instanceof ApiError && reason.code === "project_not_found";
          setProjects((known) => ({ ...known, [id]: gone ? "gone" : "failed" }));
        },
      );
    }
    return () => controller.abort();
  }, [ids]);

  const labelOf = (place: FavoritePlace): string => {
    const project = projects[place.projectId];
    if (project === "gone") return t("mobile.favorites.notShared");
    if (!project || project === "failed") return t("mobile.favorites.project");
    return place.side === "host" ? `${project.project.label} · ${project.host_label || t("mobile.files.side.host")}` : project.project.label;
  };
  // Sorted by name only once every project's name is in: groups sorted as
  // names arrive one by one would jump under the reader's finger.
  const named = places.every((place) => projects[place.projectId] !== undefined);
  const sorted = named ? [...places].sort((a, b) => labelOf(a).localeCompare(labelOf(b))) : places;

  useEffect(() => {
    if (!viewer || library) return;
    // The library takes its own Escape; the viewer here closes as Back does.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      goBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, library]);

  const settle = (picked: Picked, isStale: boolean) => setStale((known) => {
    const key = staleKey(picked);
    if (known.has(key) === isStale) return known;
    const next = new Set(known);
    if (isStale) next.add(key);
    else next.delete(key);
    return next;
  });

  const open = (picked: Picked) => {
    const { place, item } = picked;
    setFailure(null);
    void lookUpSaved(place.projectId, item, place.side).then(
      (entry) => {
        settle(picked, !entry);
        if (!entry) {
          setSheet({ ...picked, gone: true });
        } else if (entry.kind === "dir") {
          rememberFilesPlace(place.placeId, [...item.trail, { token: entry.token, name: entry.name }]);
          setLibrary(place);
        } else {
          noteFileOpened(place.projectId, place.side, entry, item.trail);
          setViewer({ place, file: asViewerFile(entry) });
        }
      },
      (reason: unknown) => setFailure(failureKey(reason)),
    );
  };

  /** Show in folder: the library opens where the item sits. */
  const show = ({ place, item }: Picked) => {
    rememberFilesPlace(place.placeId, item.trail);
    setLibrary(place);
  };

  const pick = (picked: Picked, key: string) => {
    setSheet(null);
    if (key === "open") open(picked);
    else if (key === "show") show(picked);
    else removeFavorite(picked.place.placeId, picked.item);
  };

  const scopeOf = ({ projectId, side }: FavoritePlace): ViewerScope => side === "host" ? { files: projectId, on: "host" } : { files: projectId };

  return <section className="home-favorites" aria-label={t("mobile.files.favorites")}>
    {isUntested("mobile.files.favoritesPage") && <span className="untested">{t("mobile.newTab.untested")}</span>}
    {failure && <p className="sheet-note error" role="alert">{t(failure)}</p>}
    {sorted.length === 0 && <div className="home-empty">
      <span className="home-empty-glyph" aria-hidden="true">☆</span>
      <strong>{t("mobile.favorites.emptyTitle")}</strong>
      <p>{t("mobile.favorites.empty")}</p>
    </div>}
    {sorted.map((place) => <section className="files-saved" key={place.placeId} aria-label={labelOf(place)}>
      <h3>{labelOf(place)}</h3>
      <ul className={projects[place.projectId] === "gone" ? "option-list files-list files-stale" : "option-list files-list"}>
        {place.items.map((item) => {
          const picked = { place, item };
          const folder = item.kind === "dir";
          return <li key={savedPlace(item)} className={stale.has(staleKey(picked)) ? "files-stale" : undefined}>
            <button onClick={() => open(picked)} aria-label={t(folder ? "mobile.files.openFolder" : "mobile.files.openFile", { name: item.name })}>
              <FileGlyph kind={item.kind} color={folder ? tabColorCss(place.colors.get(savedPlace(item))) : undefined} />
              <span>
                <strong>{item.name}</strong>
                <small className="files-hit-place">{item.trail.length ? item.trail.map((crumb) => crumb.name).join("/") : t("mobile.files.atRoot")}</small>
              </span>
              {folder && <svg className="files-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>}
            </button>
            <button className="files-more" aria-haspopup="dialog" aria-label={t("mobile.files.item.menu", { name: item.name })} onClick={() => setSheet({ ...picked, gone: false })}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01" /></svg>
            </button>
          </li>;
        })}
      </ul>
    </section>)}
    {sheet && <OptionSheet title={sheet.item.name} waiting="" busy={false} onClose={() => setSheet(null)}
      note={sheet.gone ? { text: t("mobile.files.saved.gone", { name: sheet.item.name }) } : undefined}
      options={sheet.gone
        ? [{ key: "remove", label: t("mobile.files.saved.remove"), current: false }]
        : [
          { key: "open", label: t("mobile.files.item.open"), current: false },
          { key: "show", label: t("mobile.files.item.show"), current: false },
          { key: "remove", label: t("mobile.files.item.unfavorite"), current: false },
        ]}
      onPick={(key) => pick(sheet, key)} />}
    {library && <FilesLibrary key={library.placeId} projectId={library.projectId} label={labelOf(library)} side={library.side} onClose={() => setLibrary(null)} />}
    {viewer && <OutboxViewer key={viewer.file.ref} scope={scopeOf(viewer.place)} file={viewer.file} onClose={() => setViewer(null)} />}
  </section>;
}
