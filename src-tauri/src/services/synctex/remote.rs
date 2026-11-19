//! A host map stays in memory. Only SFTP resolves or stats host paths.
use super::*;
use crate::services::fs_confine::confine_remote_abs;
use crate::services::{
    remote::{RemotePoolState, RemoteTarget},
    sftp,
};
use openssh_sftp_client::Sftp;

pub(crate) struct RemoteMap {
    map: Arc<Map>,
    spelling: Spelling,
    pub status: MapStatus,
}

impl RemoteMap {
    pub fn resolve(&self, page: u32, x: f64, y: f64) -> Option<(String, u32)> {
        resolve_in(&self.map, &self.spelling, page, x, y)
    }
    pub fn view(&self, input: &str, line: u32) -> Vec<SyncRect> {
        view_among(
            self.map.line_boxes(),
            &self.map.pre,
            &self.spelling,
            input,
            line,
        )
    }
    pub fn pages(&self, pdf: &Path) -> Vec<PageLines> {
        pdf.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| page_lines_in(&self.map, s))
            .unwrap_or_default()
    }
}

async fn canonical(sftp: &Sftp, path: &str) -> Result<PathBuf, String> {
    sftp.fs()
        .canonicalize(path)
        .await
        .map_err(|e| format!("canonicalize {path}: {e}"))
}

pub(crate) async fn load(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    pdf: &str,
    freshness: bool,
    input: Option<&str>,
) -> Result<Option<RemoteMap>, String> {
    let root = &target.spec.remote_path;
    if !pdf.starts_with('/') || pdf.starts_with("//") {
        return Err("expected an absolute host PDF path".into());
    }
    confine_remote_abs(root, pdf)?;
    if let Some(session) = crate::services::remote::pooled_sftp(pool, &target.project_id).await {
        return load_on(&session, target, pdf, freshness, input).await;
    }
    let spec = &target.spec;
    sftp::with_oneshot(
        &spec.user,
        &spec.host,
        spec.port,
        None,
        |session| async move {
            let result = load_on(&session, target, pdf, freshness, input).await;
            (session, result)
        },
    )
    .await
}

async fn load_on(
    sftp: &Sftp,
    target: &RemoteTarget,
    pdf: &str,
    freshness: bool,
    input: Option<&str>,
) -> Result<Option<RemoteMap>, String> {
    let root = &target.spec.remote_path;
    let real_root = canonical(sftp, root).await?;
    let confined = |p: &Path| {
        if p.starts_with(&real_root) {
            Ok(())
        } else {
            Err("SyncTeX path outside remote project".to_string())
        }
    };
    confined(&canonical(sftp, pdf).await?)?;
    let dir = pdf_dir(Path::new(pdf));
    for candidate in map_candidates(Path::new(pdf)).into_iter().flatten() {
        let name = if cfg!(windows) {
            candidate.to_string_lossy().replace('\\', "/")
        } else {
            candidate.to_string_lossy().into_owned()
        };
        confine_remote_abs(root, &name)?;
        let Some(meta) = sftp::metadata_attrs_opt_on(sftp, &name).await? else {
            continue;
        };
        let real = canonical(sftp, &name).await?;
        confined(&real)?;
        if !meta.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let size = meta.len().ok_or("missing host map size")?;
        let modified = meta.modified().map(|t| t.as_duration().as_secs());
        if size > MAX_MAP_BYTES {
            return Ok(None);
        }
        let key = CacheKey::Remote {
            project: target.project_id.clone(),
            host: target.spec.host.clone(),
            user: target.spec.user.clone(),
            port: target.spec.port,
            path: name.clone(),
            canonical: real.clone(),
        };
        let stamp = (
            SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(modified.unwrap_or_default()),
            size,
        );
        let load_guard = REMOTE_LOAD.lock().await;
        let cached = CACHE
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .filter(|c| modified.is_some() && c.path == key && c.stamp == stamp)
            .and_then(|c| Some((c.map.clone(), c.remote_spelling.clone()?)));
        let (map, mut spelling) = if let Some(hit) = cached {
            hit
        } else {
            let Some(bytes) = sftp::read_file_up_to(
                sftp,
                real.to_str().ok_or("invalid map path")?,
                MAX_MAP_BYTES,
            )
            .await?
            else {
                return Ok(None);
            };
            let mut roots = Vec::new();
            for a in dir.ancestors().take_while(|a| a.starts_with(root)) {
                roots.push((
                    a.to_owned(),
                    canonical(sftp, a.to_str().ok_or("invalid host path")?).await?,
                ));
            }
            let spelling = Spelling::from_roots(dir, roots);
            let gz = name.ends_with(".gz");
            let parsed = app_core::rt::try_blocking("remote synctex", move || {
                Ok(parse_map(bytes.as_slice(), gz, MAX_MAP_BYTES))
            })
            .await?;
            let Some(parsed) = parsed else {
                return Ok(None);
            };
            let map = Arc::new(parsed);
            *CACHE.lock().unwrap_or_else(PoisonError::into_inner) = Some(Cached {
                path: key,
                stamp,
                map: map.clone(),
                remote_spelling: Some(spelling.clone()),
            });
            (map, spelling)
        };
        drop(load_guard);
        if let Some(input) = input {
            // A moved tree permits a basename match only if the unique recorded
            // path is gone. Ask the host only when the exact match failed.
            let mut candidate = None;
            input_tags_with(&map.pre, input, &spelling, |p| {
                candidate = Some(p.to_owned());
                false
            });
            if let Some(path) = candidate {
                let name = spelling.display(&path);
                if confine_remote_abs(root, &name).is_ok()
                    && sftp::metadata_opt_on(sftp, &name).await?.is_none()
                {
                    spelling.missing_input = Some(path);
                }
            }
        }
        let mut status = MapStatus {
            has_map: true,
            ..Default::default()
        };
        if let Some(threshold) = modified
            .filter(|_| freshness)
            .map(|m| m.saturating_add(STALE_GRACE.as_secs()))
        {
            status.pdf_newer_than_map = sftp::metadata_on(sftp, pdf)
                .await?
                .1
                .is_some_and(|m| m > threshold);
            let sources = source_paths(&map.pre.inputs, &spelling, &source_root(&map, &spelling));
            for source in sources {
                if confine_remote_abs(root, &source).is_err() {
                    continue;
                }
                let Ok(real) = canonical(sftp, &source).await else {
                    continue;
                };
                if confined(&real).is_ok()
                    && sftp::metadata_on(sftp, real.to_str().ok_or("invalid source path")?)
                        .await?
                        .1
                        .is_some_and(|m| m > threshold)
                {
                    status.newer_sources.push(source);
                }
            }
        }
        return Ok(Some(RemoteMap {
            map,
            spelling,
            status,
        }));
    }
    Ok(None)
}

static REMOTE_LOAD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
