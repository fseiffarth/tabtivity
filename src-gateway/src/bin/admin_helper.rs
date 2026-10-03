//! The admin helper (hosted plan §3.1): the server's only root code. The
//! admin runs it with `sudo`; `--dry-run` prints a verb's plan and changes
//! nothing (and needs no root). Linux only.

#[cfg(target_os = "linux")]
mod cli {
    use app_gateway::db::{Db, Role};
    use app_gateway::helper::{self, Ctx, Plan, SystemAccounts, SystemExec};
    use app_gateway::units::Limits;
    use app_gateway::{brand::SLUG, names, prereq};

    fn usage() -> String {
        format!(
            "usage: sudo {SLUG}-admin-helper [--dry-run] <verb> …\n\
\n\
  install --origin https://HOST [--content-origin https://HOST:8443]\n\
  user-add NAME [--admin] [--memory 8G] [--tasks 4096] [--cpu-weight 100]\n\
  user-remove NAME          (keeps the Unix account and its home)\n\
  invite NAME               (a new single-use pairing code)\n\
  role NAME admin|user\n\
  device-revoke NAME DEVICE_ID\n\
  cli-install ID            (install or update an agent CLI, as {cli})\n\
  oidc-set --issuer https://IDP --client-id ID --name LABEL\n\
                            (sign-in through an identity provider; the client\n\
                             secret is read from stdin)\n\
  oidc-clear                (invites only again)\n\
  user-oidc NAME --sub ID | --email ADDRESS | --clear\n\
                            (who may pair NAME's devices by signing in there)\n\
  check                     (the deployment prerequisites; no root needed)\n",
            cli = names::cli_account()
        )
    }

    fn flag(args: &mut Vec<String>, name: &str) -> bool {
        let before = args.len();
        args.retain(|a| a != name);
        args.len() != before
    }

    fn value(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
        let Some(i) = args.iter().position(|a| a == name) else { return Ok(None) };
        if i + 1 >= args.len() {
            return Err(format!("{name} needs a value"));
        }
        let v = args.remove(i + 1);
        args.remove(i);
        Ok(Some(v))
    }

    fn number(args: &mut Vec<String>, name: &str, default: u32) -> Result<u32, String> {
        value(args, name)?.map(|v| v.parse().map_err(|_| format!("{name}: not a number: {v}"))).transpose().map(|v| v.unwrap_or(default))
    }

    fn positional(args: &[String], n: usize) -> Result<&str, String> {
        args.get(n).map(String::as_str).ok_or_else(usage)
    }

    pub fn main() -> Result<(), String> {
        let mut args: Vec<String> = std::env::args().skip(1).collect();
        let dry_run = flag(&mut args, "--dry-run");
        let state_dir = value(&mut args, "--gateway-state")?.map(std::path::PathBuf::from).unwrap_or_else(names::gateway_state_dir);
        let accounts = SystemAccounts;
        let verb = args.first().cloned().ok_or_else(usage)?;
        if verb == "check" {
            let db = Db::load(&state_dir).unwrap_or_default();
            let checks = helper::plan_check(&accounts, &db, &prereq::System);
            let mut failed = false;
            for c in &checks {
                let mark = match c.verdict {
                    prereq::Verdict::Ok => "ok  ",
                    prereq::Verdict::Warn => "warn",
                    prereq::Verdict::Fail => {
                        failed = true;
                        "FAIL"
                    }
                };
                println!("{mark} {:<20} {}", c.id, c.detail);
            }
            return if failed { Err("prerequisites missing".into()) } else { Ok(()) };
        }
        let db = || Db::load(&state_dir).map_err(|e| e.to_string());
        let plan: Plan = match verb.as_str() {
            "install" => {
                let origin = value(&mut args, "--origin")?.ok_or("install needs --origin https://HOST")?;
                let content = value(&mut args, "--content-origin")?;
                helper::plan_install(&accounts, &origin, content.as_deref())?
            }
            "user-add" => {
                let role = if flag(&mut args, "--admin") { Role::Admin } else { Role::User };
                let limits = Limits {
                    memory_max: value(&mut args, "--memory")?.unwrap_or_else(|| Limits::default().memory_max),
                    tasks_max: number(&mut args, "--tasks", Limits::default().tasks_max)?,
                    cpu_weight: number(&mut args, "--cpu-weight", Limits::default().cpu_weight)?,
                };
                helper::plan_user_add(&accounts, &db()?, positional(&args, 1)?, role, &limits)?
            }
            "user-remove" => helper::plan_user_remove(&db()?, positional(&args, 1)?)?,
            "invite" => helper::plan_invite(&db()?, positional(&args, 1)?)?,
            "role" => {
                let role = match positional(&args, 2)? {
                    "admin" => Role::Admin,
                    "user" => Role::User,
                    other => return Err(format!("role: admin or user, not {other}")),
                };
                helper::plan_role(&db()?, positional(&args, 1)?, role)?
            }
            "device-revoke" => helper::plan_device_revoke(&db()?, positional(&args, 1)?, positional(&args, 2)?)?,
            "cli-install" => helper::plan_cli_install(positional(&args, 1)?)?,
            "oidc-set" => {
                let issuer = value(&mut args, "--issuer")?.ok_or("oidc-set needs --issuer https://IDP")?;
                let client = value(&mut args, "--client-id")?.ok_or("oidc-set needs --client-id ID")?;
                let name = value(&mut args, "--name")?.ok_or("oidc-set needs --name LABEL (the sign-in button's)")?;
                helper::plan_oidc_set(&issuer, &client, &name)?
            }
            "oidc-clear" => helper::plan_oidc_clear(),
            "user-oidc" => {
                let link = if flag(&mut args, "--clear") {
                    None
                } else if let Some(sub) = value(&mut args, "--sub")? {
                    Some(app_gateway::oidc_wire::Link { claim: "sub".into(), value: sub })
                } else if let Some(email) = value(&mut args, "--email")? {
                    Some(app_gateway::oidc_wire::Link { claim: "email".into(), value: email })
                } else {
                    return Err("user-oidc needs --sub ID, --email ADDRESS or --clear".into());
                };
                helper::plan_user_oidc(&db()?, positional(&args, 1)?, link)?
            }
            "--help" | "-h" | "help" => {
                print!("{}", usage());
                return Ok(());
            }
            other => return Err(format!("unknown verb {other:?}\n{}", usage())),
        };
        print!("{plan}");
        if dry_run {
            println!("(dry run: nothing changed)");
            return Ok(());
        }
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } != 0 {
            return Err(format!("run it with sudo (or add --dry-run to see the plan): {SLUG}-admin-helper {}", std::env::args().skip(1).collect::<Vec<_>>().join(" ")));
        }
        std::fs::create_dir_all(&state_dir).map_err(|e| format!("{}: {e}", state_dir.display()))?;
        let ctx = Ctx { accounts: &accounts, gateway_dir: state_dir, now: app_gateway::now() };
        helper::execute(&plan, &ctx, &mut SystemExec)
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    if let Err(error) = cli::main() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("the admin helper runs on Linux only");
        std::process::exit(2);
    }
}
