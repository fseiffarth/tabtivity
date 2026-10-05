//! SLURM run/watch core for HPC projects (`docs/quirky-knitting-umbrella` plan).
//!
//! A SLURM cluster forbids real computation on the login node — everything heavy
//! goes through the scheduler (`sbatch`/`srun`). Tabtivity already connects to such a
//! host as a remote project;
//! this module lets the user submit/query/cancel jobs without memorizing the
//! commands, and the frontend turns the resulting log files and interactive shells
//! into ordinary terminal tabs (`lib/remote/hpc/slurm.ts`).
//!
//! Structure mirrors `commands::python`: each command resolves `project_dir` to a
//! remote target with `remote_target_for_dir` (threading a specific worker host via
//! `remote_target_for_host`) and runs a POSIX-`sh` script over the pooled
//! ControlMaster (`run_remote_script`), or the same script through a local shell for
//! a local project (a login node that itself has SLURM).
//!
//! **Security.** `run_remote_script` embeds its script *verbatim* — nothing may be
//! interpolated into it that a user controls without quoting. So every path is
//! `shell_quote`d (the same helper `git_peer`/`ssh_exec` use) and a job id is
//! validated numeric (`^\d+$`) before it can touch `scontrol`/`scancel`. The pure
//! parsers (`parse_submit_jobid`, `parse_scontrol_paths`, `parse_squeue`) are
//! unit-tested against captured sample output.

use serde::{Deserialize, Serialize};

use crate::services::remote::{remote_target_for_dir, remote_target_for_host, PRIMARY_HOST};
use crate::services::ssh_exec::{run_remote_script, shell_quote};

/// Whether SLURM is usable for a project's host, and its version banner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SlurmInfo {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// The result of a submit: the parsed job id plus the real output paths SLURM
/// resolved (absolute, `%j`/`%x`-expanded), so the frontend can tail the right file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SlurmSubmit {
    pub job_id: String,
    pub out_file: String,
    pub err_file: String,
    pub work_dir: String,
}

/// One row of `squeue`, for the Jobs view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SlurmJob {
    pub id: String,
    pub name: String,
    pub state: String,
    pub time: String,
    pub nodes: String,
    pub reason: String,
}

/// Paths lifted out of `scontrol show job` output.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScontrolPaths {
    pub out_file: String,
    pub err_file: String,
    pub work_dir: String,
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/// Run `script` for `project_dir` on `host_id` and return its stdout. Remote
/// projects run it over the pooled ControlMaster (the primary, or a named worker);
/// a local project (a login node with SLURM) runs it through the local shell with
/// the project dir as cwd. `host_id` defaults to the primary.
///
/// `pub(crate)` because `commands::hpc_ws` (workspaces) runs *its* tooling at the
/// exact same place a job is submitted — one dispatch, so the two can never
/// disagree about which machine "the project's host" is.
pub(crate) fn run_slurm_script(
    project_dir: &str,
    host_id: &str,
    script: &str,
) -> Result<String, String> {
    if let Some(primary) = remote_target_for_dir(project_dir) {
        let target = if host_id == PRIMARY_HOST {
            primary
        } else {
            remote_target_for_host(&primary.project_id, host_id)
                .ok_or_else(|| format!("unknown remote host '{host_id}'"))?
        };
        // Every caller of this dispatch — `slurm_*` and `hpc_ws_*` — is a button:
        // submit, cancel, refresh the queue, allocate a workspace. Reaching the
        // cluster is the whole point of the click, so the dial policy is told so
        // here, once, rather than at each of the dozen commands above it.
        let _dial = crate::services::ssh_common::user_dial(
            &target.spec.user,
            &target.spec.host,
            target.spec.port,
        );
        let out = run_remote_script(&target.spec, script)?;
        if !out.status.success() && out.stdout.is_empty() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    // Local project: run the same POSIX-sh script with the project dir as cwd.
    let out = crate::paths::command_no_window("sh")
        .arg("-c")
        .arg(script)
        .current_dir(project_dir)
        .output()
        .map_err(|e| format!("failed to run slurm command locally: {e}"))?;
    if !out.status.success() && out.stdout.is_empty() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ── Pure parsers ─────────────────────────────────────────────────────────────

/// `sbatch --parsable` prints `<jobid>` or `<jobid>;<cluster>` on its first line.
/// Returns the numeric id, or `None` if the first non-empty line isn't one (an
/// error message, an empty submit). Validating numeric here is also the injection
/// guard: only a `^\d+$` id is ever spliced into `scontrol`/`scancel`.
pub fn parse_submit_jobid(stdout: &str) -> Option<String> {
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty())?;
    let id = line.split(';').next().unwrap_or(line).trim();
    if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
        Some(id.to_string())
    } else {
        None
    }
}

/// `scontrol show job <id>` emits whitespace-separated `Key=Value` tokens across
/// several lines; we want `StdOut=`, `StdErr=`, `WorkDir=` (absolute, already
/// `%j`/`%x`-expanded by SLURM). A value can itself contain no whitespace in
/// practice for these path keys, so a plain token split is correct.
pub fn parse_scontrol_paths(stdout: &str) -> ScontrolPaths {
    let mut paths = ScontrolPaths::default();
    for tok in stdout.split_whitespace() {
        if let Some(v) = tok.strip_prefix("StdOut=") {
            paths.out_file = v.to_string();
        } else if let Some(v) = tok.strip_prefix("StdErr=") {
            paths.err_file = v.to_string();
        } else if let Some(v) = tok.strip_prefix("WorkDir=") {
            paths.work_dir = v.to_string();
        }
    }
    paths
}

/// Parse `squeue … -o '%i|%j|%T|%M|%D|%R'` output — one job per line, six
/// pipe-separated fields (`%R`, the reason, may itself contain spaces but never a
/// pipe, so `splitn(6, '|')` is safe). Blank lines are skipped.
pub fn parse_squeue(stdout: &str) -> Vec<SlurmJob> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.splitn(6, '|').collect();
        if f.len() < 6 {
            continue;
        }
        out.push(SlurmJob {
            id: f[0].trim().to_string(),
            name: f[1].trim().to_string(),
            state: f[2].trim().to_string(),
            time: f[3].trim().to_string(),
            nodes: f[4].trim().to_string(),
            reason: f[5].trim().to_string(),
        });
    }
    out
}

/// Split a script path into `(dir, base)`, both empty-safe. `dir` is the parent
/// (empty when the path is a bare file name); `base` the file name. **Absolute
/// paths are preserved** — the frontend passes the file's absolute host/local path
/// so the same command works for a remote project (where the viewer path is the
/// host-absolute path) and a local one, without either side computing a rel path.
/// Uses forward slashes (the host is POSIX). A leading `/` therefore makes `dir`
/// absolute (`/home/a/p`), so the `cd` lands correctly regardless of cwd.
fn split_script_rel(script_rel: &str) -> (String, String) {
    let s = script_rel.trim().trim_end_matches('/');
    match s.rfind('/') {
        // Keep a lone leading slash (root file `/x`): dir = "/".
        Some(0) => ("/".to_string(), s[1..].to_string()),
        Some(i) => (s[..i].to_string(), s[i + 1..].to_string()),
        None => (String::new(), s.to_string()),
    }
}

/// The default `sbatch` output file when `scontrol` couldn't be consulted:
/// `<work_dir>/slurm-<jobid>.out`, SLURM's own default pattern.
fn default_out_file(work_dir: &str, job_id: &str) -> String {
    if work_dir.is_empty() {
        format!("slurm-{job_id}.out")
    } else {
        format!("{}/slurm-{job_id}.out", work_dir.trim_end_matches('/'))
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────
//
// Every command here shells out (locally or over the pooled SSH ControlMaster,
// which can stall up to its ConnectTimeout/ServerAlive window on a dead/degraded
// host). Tauri runs a synchronous `#[command]` on the MAIN thread, so doing that
// work inline froze the whole window — the same bug `commands::git` already fixed
// (see its `run_off_thread` doc comment) but that fix never reached this file.
// Each command is now an `async` wrapper that offloads its blocking body via
// `spawn_blocking`, so the UI thread stays free; the bodies are ordinary sync fns
// so they stay directly callable from the unit tests below.

async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("slurm task failed: {e}"))?
}

/// Is SLURM available on the project's host? Lets the UI hide itself off-HPC.
#[tauri::command]
pub async fn slurm_available(
    project_dir: String,
    host_id: Option<String>,
) -> Result<SlurmInfo, String> {
    run_off_thread(move || {
        let host = host_id.as_deref().unwrap_or(PRIMARY_HOST);
        // Constant script — nothing interpolated.
        let script = "command -v sbatch >/dev/null 2>&1 || exit 0\n\
                      sbatch --version 2>/dev/null | head -n1";
        let out = run_slurm_script(&project_dir, host, script).unwrap_or_default();
        let version = out.lines().next().map(str::trim).filter(|s| !s.is_empty());
        Ok(SlurmInfo {
            available: version.is_some(),
            version: version.map(str::to_string),
        })
    })
    .await
}

/// Submit `script_rel` (project-relative) with `sbatch`, then resolve its real
/// output paths via `scontrol` — in one round trip: the numeric job id comes from
/// `sbatch`'s own output, so chaining `scontrol` on it injects nothing.
#[tauri::command]
pub async fn slurm_submit(
    project_dir: String,
    script_rel: String,
    host_id: Option<String>,
) -> Result<SlurmSubmit, String> {
    run_off_thread(move || {
        let host = host_id.as_deref().unwrap_or(PRIMARY_HOST);
        let (dir, base) = split_script_rel(&script_rel);
        if base.is_empty() {
            return Err("no script file given".into());
        }
        // cd into the script's own directory so the job's default WorkDir is where
        // the script lives; sbatch --parsable prints the job id; scontrol (fed
        // sbatch's own id) resolves the absolute out/err/work paths. `${jid%%;*}`
        // strips a `;<cluster>` suffix for the scontrol lookup.
        let cd = if dir.is_empty() {
            String::new()
        } else {
            format!("cd {} && ", shell_quote(&dir))
        };
        let script = format!(
            "{cd}jid=$(sbatch --parsable {base}) || exit 1\n\
             printf '%s\\n' \"$jid\"\n\
             scontrol show job \"${{jid%%;*}}\" 2>/dev/null",
            base = shell_quote(&base),
        );
        let stdout = run_slurm_script(&project_dir, host, &script)?;

        let mut lines = stdout.lines();
        let first = lines.next().unwrap_or("").trim();
        let job_id = parse_submit_jobid(first)
            .ok_or_else(|| format!("sbatch did not return a job id:\n{}", stdout.trim()))?;
        let rest: String = lines.collect::<Vec<_>>().join("\n");
        let paths = parse_scontrol_paths(&rest);

        let out_file = if paths.out_file.is_empty() {
            default_out_file(&paths.work_dir, &job_id)
        } else {
            paths.out_file
        };
        Ok(SlurmSubmit {
            job_id,
            out_file,
            err_file: paths.err_file,
            work_dir: paths.work_dir,
        })
    })
    .await
}

/// The current user's jobs on the host. `--me` (newer SLURM) with a `-u "$USER"`
/// fallback for sites where it isn't supported. Constant script.
#[tauri::command]
pub async fn slurm_queue(
    project_dir: String,
    host_id: Option<String>,
) -> Result<Vec<SlurmJob>, String> {
    run_off_thread(move || {
        let host = host_id.as_deref().unwrap_or(PRIMARY_HOST);
        let fmt = "%i|%j|%T|%M|%D|%R";
        let script = format!(
            "squeue --me --noheader -o '{fmt}' 2>/dev/null || \
             squeue -u \"$USER\" --noheader -o '{fmt}'"
        );
        let stdout = run_slurm_script(&project_dir, host, &script)?;
        Ok(parse_squeue(&stdout))
    })
    .await
}

/// Resolve a job's stdout path via `scontrol` — for **Watch** on a job Tabtivity did
/// not submit this session (so the session store has no path for it). Returns the
/// absolute `StdOut`, or a `slurm-<id>.out` fallback when scontrol is silent (a
/// job that already finished). The id is validated numeric.
///
/// `log_dir` is the project's recorded HPC log folder
/// (`Project.hpc.logs_dir`, `docs/hpc_workspace_plan.md`): when the pipeline
/// routes `--output` into the home anchor, `<WorkDir>/slurm-<id>.out` is simply
/// the wrong guess, and Watch on an older job would tail a file that never
/// existed. Given one, it wins over `WorkDir` — but only for the *fallback*;
/// whatever `scontrol` states still beats both, since that is what SLURM
/// actually used.
#[tauri::command]
pub async fn slurm_job_out(
    project_dir: String,
    job_id: String,
    host_id: Option<String>,
    log_dir: Option<String>,
) -> Result<String, String> {
    run_off_thread(move || {
        let host = host_id.as_deref().unwrap_or(PRIMARY_HOST);
        if job_id.is_empty() || !job_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("invalid job id '{job_id}'"));
        }
        let stdout = run_slurm_script(&project_dir, host, &format!("scontrol show job {job_id}"))?;
        let paths = parse_scontrol_paths(&stdout);
        if !paths.out_file.is_empty() {
            return Ok(paths.out_file);
        }
        let dir = log_dir
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .unwrap_or(&paths.work_dir);
        Ok(default_out_file(dir, &job_id))
    })
    .await
}

/// Cancel a job. The id is validated numeric before it touches the command.
#[tauri::command]
pub async fn slurm_cancel(
    project_dir: String,
    job_id: String,
    host_id: Option<String>,
) -> Result<(), String> {
    run_off_thread(move || {
        let host = host_id.as_deref().unwrap_or(PRIMARY_HOST);
        if job_id.is_empty() || !job_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("invalid job id '{job_id}'"));
        }
        run_slurm_script(&project_dir, host, &format!("scancel {job_id}"))?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_jobid_plain_and_with_cluster_suffix() {
        assert_eq!(parse_submit_jobid("1234567\n").as_deref(), Some("1234567"));
        assert_eq!(
            parse_submit_jobid("1234567;cluster\n").as_deref(),
            Some("1234567")
        );
    }

    #[test]
    fn submit_jobid_rejects_error_text() {
        assert!(parse_submit_jobid("sbatch: error: Batch job submission failed").is_none());
        assert!(parse_submit_jobid("").is_none());
        assert!(parse_submit_jobid("\n\n").is_none());
    }

    #[test]
    fn scontrol_paths_are_lifted_from_tokens() {
        let out = "JobId=1234567 JobName=train\n   \
                   UserId=alice(1000) GroupId=alice(1000)\n   \
                   WorkDir=/home/alice/proj StdOut=/home/alice/proj/slurm-1234567.out \
                   StdErr=/home/alice/proj/slurm-1234567.err\n";
        let p = parse_scontrol_paths(out);
        assert_eq!(p.work_dir, "/home/alice/proj");
        assert_eq!(p.out_file, "/home/alice/proj/slurm-1234567.out");
        assert_eq!(p.err_file, "/home/alice/proj/slurm-1234567.err");
    }

    #[test]
    fn scontrol_paths_empty_when_absent() {
        assert_eq!(
            parse_scontrol_paths("JobId=1 JobName=x"),
            ScontrolPaths::default()
        );
    }

    #[test]
    fn squeue_rows_are_parsed() {
        let out = "42|train.slurm|RUNNING|1:23|2|(None)\n\
                   43|prep|PENDING|0:00|1|(Priority)\n\n";
        let jobs = parse_squeue(out);
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].id, "42");
        assert_eq!(jobs[0].name, "train.slurm");
        assert_eq!(jobs[0].state, "RUNNING");
        assert_eq!(jobs[0].nodes, "2");
        assert_eq!(jobs[0].reason, "(None)");
        assert_eq!(jobs[1].state, "PENDING");
        assert_eq!(jobs[1].reason, "(Priority)");
    }

    #[test]
    fn squeue_reason_with_spaces_survives() {
        // %R can be a multi-word reason; splitn(6) keeps it whole.
        let jobs = parse_squeue("7|j|PENDING|0:00|1|(Resources not available)\n");
        assert_eq!(jobs[0].reason, "(Resources not available)");
    }

    #[test]
    fn squeue_short_lines_skipped() {
        assert!(parse_squeue("garbage\n1|2|3\n").is_empty());
    }

    #[test]
    fn split_script_rel_variants() {
        assert_eq!(
            split_script_rel("train.slurm"),
            ("".into(), "train.slurm".into())
        );
        assert_eq!(
            split_script_rel("jobs/train.slurm"),
            ("jobs".into(), "train.slurm".into())
        );
        assert_eq!(
            split_script_rel("a/b/c.slurm"),
            ("a/b".into(), "c.slurm".into())
        );
    }

    #[test]
    fn split_script_rel_keeps_absolute_paths() {
        // The frontend passes the file's absolute path; the leading slash must
        // survive so the `cd` is absolute (host-agnostic between remote/local).
        assert_eq!(
            split_script_rel("/home/alice/proj/train.slurm"),
            ("/home/alice/proj".into(), "train.slurm".into())
        );
        assert_eq!(
            split_script_rel("/train.slurm"),
            ("/".into(), "train.slurm".into())
        );
    }

    #[test]
    fn default_out_file_follows_slurm_pattern() {
        assert_eq!(
            default_out_file("/home/alice/proj", "42"),
            "/home/alice/proj/slurm-42.out"
        );
        assert_eq!(default_out_file("", "42"), "slurm-42.out");
    }
}
