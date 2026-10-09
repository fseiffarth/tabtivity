//! Project-VM lifecycle (`docs/vm_projects_plan.md`): the third trust tier.
//! A VM project's whole tree lives inside a locally booted QEMU/KVM guest that
//! Tabtivity reaches **exclusively over SSH/SFTP** on a forwarded loopback port —
//! no shared filesystem, no virtiofs/9p, deliberately. From the moment the VM
//! is up, the project is an ordinary remote project (`services::remote` pool,
//! `ssh -tt` tabs, optional git lockstep); this module owns only what a real
//! remote host doesn't have: boot, readiness, shutdown, the per-VM SSH
//! identity, and the orphan sweep.
//!
//! Modeled on `services::sandbox`'s shape (preflight → ensure-running →
//! teardown → startup sweep), with the container's Docker daemon replaced by a
//! direct `qemu-system-<arch>` invocation on the host's own hypervisor — KVM on
//! Linux, Hypervisor.framework on macOS, the Windows Hypervisor Platform on
//! Windows ([`machine_args_for`]) — no libvirt, no root, no bridge networking.
//! The guest follows the host architecture (an x86-64 image on x86-64, an arm64
//! image on Apple silicon / arm64 Linux), because acceleration only ever runs
//! a same-architecture guest. Networking is user-mode slirp with a
//! `hostfwd=tcp:127.0.0.1:<port>-:22` forward; the egress story
//! (`services::vm_proxy`) hangs off the same netdev.
//!
//! Two host differences are absorbed here rather than surfaced: Windows QEMU
//! cannot `-daemonize`, so the process is spawned detached and its pidfile
//! polled, and it has no Unix sockets, so QMP rides a loopback TCP port
//! recorded in `vm.json`. The cloud-init seed is written by
//! `services::iso9660` when no `genisoimage`-class tool is installed, which on
//! macOS and Windows is always.
//!
//! State layout (`<state_dir>/vm/`):
//! ```text
//! images/<stock cloud image>, images/tabtivity-base-<ver>.qcow2
//! <project-id>/disk.qcow2      # per-project qcow2 overlay (copy-on-write)
//! <project-id>/seed/…,seed.iso # cloud-init NoCloud seed (user, key, proxy env)
//! <project-id>/id_ed25519(.pub)# per-VM generated keypair
//! <project-id>/known_hosts     # per-VM host keys (never ~/.ssh/known_hosts)
//! <project-id>/qemu.pid, qmp.sock, serial.log, vm.json
//! ```
//!
//! The per-VM `UserKnownHostsFile` matters: a recreated VM has a new host key,
//! and the user's real `known_hosts` must never collect or conflict on
//! `[127.0.0.1]:<port>` entries. We booted this VM ourselves, so first-contact
//! trust is by construction — [`vm_ssh_opts`] injects the per-VM files into
//! every ssh argv aimed at a live VM's forwarded port (hooked in
//! `ssh_common`'s base builders + `ssh_exec::ssh_pty_args`).
//!
//! Ports are allocated fresh at every boot and rewritten into the project's
//! `RemoteSpec` (`projects.json` + `project.json`) before connecting — nothing
//! may assume they are stable across boots.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::schema::project::{RemoteSpec, VmEgress, VmSpec};
use crate::schema::projects::ProjectsList;
use crate::storage;

/// The guest account every VM project runs as; its home holds the tree.
pub const VM_USER: &str = crate::brand::VM_USER;
/// The project root inside the guest — the `RemoteSpec.remote_path` a VM
/// project is created with.
pub const VM_PROJECT_DIR: &str = crate::brand::VM_PROJECT_DIR;

/// Baked-base-image version: bump when the bake recipe changes so an outdated
/// base is rebuilt on demand (never automatically).
pub const BASE_VERSION: u32 = 1;

/// The stock Ubuntu LTS release the tier bootstraps from (fetch once,
/// checksum-verified against the release's own SHA256SUMS). The image file is
/// per guest architecture ([`GuestArch::stock_image_name`]).
const STOCK_RELEASE_URL: &str = "https://cloud-images.ubuntu.com/releases/noble/release";
const STOCK_SUMS_URL: &str = "https://cloud-images.ubuntu.com/releases/noble/release/SHA256SUMS";

// ── Guest architecture + host hypervisor ───────────────────────────────────

/// The guest CPU architecture, which follows the host's: hardware acceleration
/// (KVM / HVF / WHPX) only ever runs a guest of the host's own architecture, and
/// an emulated guest is too slow to hold a working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestArch {
    X86_64,
    Aarch64,
}

impl GuestArch {
    pub fn host() -> Self {
        if cfg!(target_arch = "aarch64") {
            GuestArch::Aarch64
        } else {
            GuestArch::X86_64
        }
    }

    pub fn qemu_binary(self) -> &'static str {
        match self {
            GuestArch::X86_64 => "qemu-system-x86_64",
            GuestArch::Aarch64 => "qemu-system-aarch64",
        }
    }

    fn stock_image_name(self) -> &'static str {
        match self {
            GuestArch::X86_64 => "ubuntu-24.04-server-cloudimg-amd64.img",
            GuestArch::Aarch64 => "ubuntu-24.04-server-cloudimg-arm64.img",
        }
    }

    /// The baked image keeps its historical name on x86-64 (existing state
    /// dirs), and carries the arch elsewhere.
    fn baked_image_name(self) -> String {
        self.baked_image_name_for(&crate::brand::CURRENT)
    }

    /// [`baked_image_name`](Self::baked_image_name) as a build named `forms`
    /// writes it.
    fn baked_image_name_for(self, forms: &crate::brand::Forms) -> String {
        let prefix = forms.name(crate::brand::Name::VM_BASE_IMAGE_PREFIX);
        match self {
            GuestArch::X86_64 => format!("{prefix}{BASE_VERSION}.qcow2"),
            GuestArch::Aarch64 => format!("{prefix}{BASE_VERSION}-arm64.qcow2"),
        }
    }

    /// The `virt` machine on arm64 boots through UEFI firmware, which QEMU
    /// ships as `edk2-aarch64-code.fd` (distros also package it under a few
    /// other names). x86-64's `q35` has SeaBIOS built in and needs none.
    fn needs_firmware(self) -> bool {
        matches!(self, GuestArch::Aarch64)
    }
}

/// The host OS the argv is being built for. Pure input so the builders are
/// testable for every OS from any OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Linux,
    Macos,
    Windows,
}

impl HostOs {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            HostOs::Macos
        } else if cfg!(target_os = "windows") {
            HostOs::Windows
        } else {
            HostOs::Linux
        }
    }
}

/// Where a distro or QEMU install keeps the arm64 UEFI code image.
fn find_aarch64_firmware() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
        "/usr/local/share/qemu/edk2-aarch64-code.fd",
        "/usr/share/qemu/edk2-aarch64-code.fd",
        "/usr/share/edk2/aarch64/QEMU_EFI.fd",
        "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd",
        "/usr/share/AAVMF/AAVMF_CODE.fd",
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// The accelerator, machine and CPU argv for `(os, arch)`. Pure.
///
/// - Linux: `-enable-kvm`; macOS: `-accel hvf`; Windows: `-accel whpx`.
/// - x86-64 guests use `q35` with `-cpu host`, except under WHPX, which does
///   not expose the host CPU model and takes `max` (the fullest model the
///   accelerator supports) instead.
/// - arm64 guests use the `virt` machine with `-cpu host` and the UEFI code
///   image in `firmware`. `highmem=on` is the default and stated for clarity.
///
/// `None` for a pairing no hypervisor serves (arm64 Windows: WHPX is x86-only).
pub(crate) fn machine_args_for(os: HostOs, arch: GuestArch, firmware: Option<&Path>) -> Option<Vec<String>> {
    let accel: Vec<String> = match os {
        HostOs::Linux => vec!["-enable-kvm".into()],
        HostOs::Macos => vec!["-accel".into(), "hvf".into()],
        HostOs::Windows => {
            if arch == GuestArch::Aarch64 {
                return None;
            }
            vec!["-accel".into(), "whpx".into()]
        }
    };
    let mut args = accel;
    match arch {
        GuestArch::X86_64 => {
            args.extend(["-machine".into(), "q35".into(), "-cpu".into()]);
            args.push(if os == HostOs::Windows { "max".into() } else { "host".into() });
        }
        GuestArch::Aarch64 => {
            args.extend([
                "-machine".into(),
                "virt,highmem=on".into(),
                "-cpu".into(),
                "host".into(),
            ]);
            if let Some(fw) = firmware {
                args.extend(["-bios".into(), fw.display().to_string()]);
            }
        }
    }
    Some(args)
}

/// This host's machine argv, or the reason there is none.
fn machine_args() -> Result<Vec<String>, String> {
    let arch = GuestArch::host();
    let firmware = if arch.needs_firmware() {
        Some(find_aarch64_firmware().ok_or_else(|| {
            "No arm64 UEFI firmware (edk2-aarch64-code.fd) found; install QEMU's firmware package."
                .to_string()
        })?)
    } else {
        None
    };
    machine_args_for(HostOs::current(), arch, firmware.as_deref())
        .ok_or_else(|| "No hardware virtualization is available for this host/guest pairing.".to_string())
}

// ── Paths ──────────────────────────────────────────────────────────────────

pub fn vm_root() -> PathBuf {
    storage::state_dir().join("vm")
}

pub fn images_dir() -> PathBuf {
    vm_root().join("images")
}

pub fn vm_dir(project_id: &str) -> PathBuf {
    // Project ids are uuids (minted by us); sanitize anyway so a hand-edited
    // projects.json can never traverse out of the vm root.
    let safe: String = project_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    vm_root().join(safe)
}

fn stock_image_path() -> PathBuf {
    images_dir().join(GuestArch::host().stock_image_name())
}

fn baked_image_path() -> PathBuf {
    baked_image_path_in(&crate::brand::PAIR, &images_dir())
}

/// The baked image in `images`: under its current name, or — while only that
/// exists — under the name an older build baked it as. That file is never
/// renamed: the overlays of existing VMs name it as their backing file. A new
/// bake writes the current name.
fn baked_image_path_in(pair: &crate::brand::Pair, images: &Path) -> PathBuf {
    let current = images.join(GuestArch::host().baked_image_name_for(&pair.cur));
    if pair.legacy(crate::brand::Name::VM_BASE_IMAGE_PREFIX).is_none() || current.is_file() {
        return current;
    }
    let old = images.join(GuestArch::host().baked_image_name_for(&pair.legacy));
    if old.is_file() {
        crate::brand::legacy_hit("vm-base-image");
        old
    } else {
        current
    }
}

/// Where a bake writes: always the current name.
fn baked_image_target() -> PathBuf {
    images_dir().join(GuestArch::host().baked_image_name())
}

/// The base image a new overlay should back onto: the baked toolchain image
/// when present, else the stock cloud image (bootable with sshd out of the
/// box — the bake only adds the agent toolchain). `None` when neither exists.
pub fn base_image_path() -> Option<PathBuf> {
    let baked = baked_image_path();
    if baked.is_file() {
        return Some(baked);
    }
    let stock = stock_image_path();
    stock.is_file().then_some(stock)
}

// ── Runtime state (vm.json + in-memory registry) ───────────────────────────

/// What a boot records in `<vm dir>/vm.json` — enough for the sweep and the
/// status pill to reason about a VM this process (or a crashed predecessor)
/// started.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmRuntime {
    pub pid: u32,
    pub ssh_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_port: Option<u16>,
    /// Windows: the loopback port QMP listens on (no Unix sockets there).
    /// Absent on Unix, where QMP is `qmp.sock` in the VM dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qmp_port: Option<u16>,
    pub egress: VmEgress,
    /// The base image the overlay was created against (display only).
    pub base_image: String,
}

#[derive(Debug, Clone)]
struct RunningVm {
    dir: PathBuf,
    runtime: VmRuntime,
}

fn registry() -> &'static Mutex<HashMap<String, RunningVm>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, RunningVm>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-project boot lock so two activations can't race a double boot.
fn boot_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn boot_lock_for(project_id: &str) -> Arc<Mutex<()>> {
    boot_locks()
        .lock()
        .unwrap()
        .entry(project_id.to_string())
        .or_default()
        .clone()
}

/// Extra `ssh -o` options for a target that is a live project VM: the per-VM
/// known_hosts + identity. Empty for every other target, so the `ssh_common`
/// base builders can call this unconditionally. Matching is by (loopback
/// host, forwarded port) against the in-memory registry — only a VM booted by
/// this process can match, which is exactly the authorization the bypass
/// needs (we generated the key and booted the machine ourselves).
pub fn vm_ssh_opts(host: &str, port: Option<u16>) -> Vec<String> {
    let Some(port) = port else { return Vec::new() };
    let host = host.trim().to_ascii_lowercase();
    if host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return Vec::new();
    }
    let reg = registry().lock().unwrap();
    // A **live** claim on the port wins over a stale one. A QEMU killed from
    // outside (or crashed) leaves its registry entry behind and releases its
    // port back to the ephemeral pool, so the next VM can be handed exactly it —
    // and an arbitrary `values()` order would then lend the new VM the dead
    // one's identity and known_hosts: an ssh authenticating with the wrong key
    // against a host key recorded for a machine that no longer exists, i.e. a
    // refusal wearing the wording of a MITM. Liveness only *ranks* the match; a
    // sole claimant still answers, because coming back empty would send the
    // connection to the user's real `~/.ssh/known_hosts`, which is the one thing
    // this injection exists to prevent.
    let by_port = |vm: &&RunningVm| vm.runtime.ssh_port == port;
    let Some(vm) = reg
        .values()
        .find(|vm| by_port(vm) && pid_is_live_qemu(vm.runtime.pid))
        .or_else(|| reg.values().find(by_port))
    else {
        return Vec::new();
    };
    vec![
        "-o".to_string(),
        format!(
            "UserKnownHostsFile={}",
            vm.dir.join("known_hosts").to_string_lossy()
        ),
        "-o".to_string(),
        format!(
            "IdentityFile={}",
            vm.dir.join("id_ed25519").to_string_lossy()
        ),
        "-o".to_string(),
        "IdentitiesOnly=yes".to_string(),
    ]
}

/// Whether a `RemoteSpec` is a project VM's synthesized endpoint (the marker
/// written at creation — see `schema::project::RemoteSpec::vm`).
pub fn is_vm_spec(spec: &RemoteSpec) -> bool {
    spec.vm == Some(true)
}

/// The `VmSpec` mirrored into a `projects.json` entry's `extra["vm"]`, or
/// `None` for a non-VM project. The always-local copy, like `sandbox`'s.
pub fn vm_spec_for(project_id: &str) -> Option<VmSpec> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.into_iter().find(|e| e.id == project_id)?;
    let value = entry.extra.get("vm")?;
    serde_json::from_value(value.clone()).ok()
}

/// Whether this project's VM is currently running (registry + live pid).
pub fn is_running(project_id: &str) -> bool {
    let reg = registry().lock().unwrap();
    reg.get(project_id)
        .map(|vm| pid_is_live_qemu(vm.runtime.pid))
        .unwrap_or(false)
}

/// The live runtime record for a running VM (`None` when off).
pub fn running_state(project_id: &str) -> Option<VmRuntime> {
    let reg = registry().lock().unwrap();
    reg.get(project_id)
        .filter(|vm| pid_is_live_qemu(vm.runtime.pid))
        .map(|vm| vm.runtime.clone())
}

// ── Doctor ─────────────────────────────────────────────────────────────────

/// The creation dialog's preflight verdict (surfaced like the sandbox's Docker
/// preflight): can this machine boot project VMs, and what's missing if not.
#[derive(Debug, Clone, Serialize)]
pub struct VmDoctorReport {
    /// Whether a hypervisor exists for this host and guest architecture at all
    /// (every desktop except arm64 Windows). When false the tier is hidden.
    pub supported: bool,
    /// Everything needed to boot is present (base image handled separately —
    /// missing base is a one-click fetch, not an unavailable tier).
    pub ok: bool,
    pub qemu: bool,
    pub kvm: bool,
    pub qemu_img: bool,
    /// Which ISO-authoring tool the seed will use, when one is installed.
    pub iso_tool: Option<String>,
    /// Free space in the state dir's filesystem, GiB.
    pub disk_free_gb: Option<u64>,
    /// Whether a base image (stock or baked) is already on disk.
    pub base_image_ready: bool,
    /// Whether the *baked* (toolchain) image is on disk — when false a VM
    /// still boots from the stock image, just without the agent toolchain.
    pub baked_image_ready: bool,
    /// Actionable text for each failed probe.
    pub reasons: Vec<String>,
    /// For a missing base image: the build-tab command that fetches it
    /// (house convention — one click, never copy-it-yourself).
    pub fetch_command: Option<String>,
    /// The build-tab command that bakes the toolchain base image (Phase 3).
    pub bake_command: Option<String>,
    /// For missing *host packages* (QEMU, qemu-img, arm64 firmware, a seed
    /// tool): the one command that installs them, so the dialog can offer a
    /// button that runs it instead of a sentence to retype (house rule: any
    /// install-via-command flow is one click). `None` when nothing is missing
    /// that a package manager fixes — `/dev/kvm` access and disk space are
    /// reasons to read, not to install.
    pub install_command: Option<String>,
}

/// The raw probe results [`doctor_verdict`] reasons from — split so the
/// verdict is testable without qemu on the test machine.
#[derive(Debug, Clone)]
pub struct VmDoctorProbes {
    pub supported: bool,
    pub qemu: bool,
    pub kvm: bool,
    pub kvm_reason: Option<String>,
    pub qemu_img: bool,
    pub iso_tool: Option<String>,
    pub disk_free_gb: Option<u64>,
    pub base_image_ready: bool,
    pub baked_image_ready: bool,
    /// The arm64 UEFI image was found (always true where none is needed).
    pub firmware_ok: bool,
}

impl Default for VmDoctorProbes {
    fn default() -> Self {
        VmDoctorProbes {
            supported: false,
            qemu: false,
            kvm: false,
            kvm_reason: None,
            qemu_img: false,
            iso_tool: None,
            disk_free_gb: None,
            base_image_ready: false,
            baked_image_ready: false,
            firmware_ok: true,
        }
    }
}

/// How to get QEMU on this host, for the doctor's sentence.
fn qemu_install_hint() -> &'static str {
    match HostOs::current() {
        HostOs::Linux => "Install QEMU (e.g. `sudo apt install qemu-system-x86 qemu-utils`).",
        HostOs::Macos => "Install QEMU (`brew install qemu`).",
        HostOs::Windows => {
            "Install QEMU for Windows (qemu.org → Download → Windows) into C:\\Program Files\\qemu."
        }
    }
}

/// The package-manager command that installs whatever host packages the probes
/// found missing, for `host`/`arch`. Pure (no path lookups), so the button's
/// command is testable for every OS from any OS. `None` when nothing missing is
/// installable — a kvm permission problem or a full disk is not.
///
/// Only the *packages* appear here. The Linux line follows the same apt
/// convention as the rest of Tabtivity's install buttons; a non-apt distro's user
/// still has the doctor's sentences above the button.
fn install_command_for(host: HostOs, arch: GuestArch, p: &VmDoctorProbes) -> Option<String> {
    if !p.supported {
        return None;
    }
    let needs_qemu = !p.qemu || !p.qemu_img || (arch.needs_firmware() && !p.firmware_ok);
    let needs_iso = p.iso_tool.is_none();
    if !needs_qemu && !needs_iso {
        return None;
    }
    match host {
        HostOs::Linux => {
            let mut pkgs: Vec<&str> = Vec::new();
            if !p.qemu {
                pkgs.push(match arch {
                    GuestArch::X86_64 => "qemu-system-x86",
                    GuestArch::Aarch64 => "qemu-system-arm",
                });
            }
            if !p.qemu_img {
                pkgs.push("qemu-utils");
            }
            if arch.needs_firmware() && !p.firmware_ok {
                pkgs.push("qemu-efi-aarch64");
            }
            if needs_iso {
                pkgs.push("genisoimage");
            }
            Some(format!("sudo apt-get install -y {}", pkgs.join(" ")))
        }
        // One formula covers every piece: Homebrew's qemu carries qemu-img and
        // the UEFI firmware, and xorriso is the seed tool it can install.
        HostOs::Macos => {
            let mut pkgs: Vec<&str> = Vec::new();
            if needs_qemu {
                pkgs.push("qemu");
            }
            if needs_iso {
                pkgs.push("xorriso");
            }
            Some(format!("brew install {}", pkgs.join(" ")))
        }
        // winget's QEMU ships qemu-img and the firmware images too; no seed tool
        // is packaged there (the built-in ISO writer covers it).
        HostOs::Windows => needs_qemu
            .then(|| "winget install --id SoftwareFreedomConservancy.QEMU -e --source winget".to_string()),
    }
}

/// Pure: fold probe results into the report (minus the command fields, which
/// need real paths).
pub fn doctor_verdict(p: &VmDoctorProbes) -> VmDoctorReport {
    let mut reasons = Vec::new();
    if !p.supported {
        reasons.push(
            "Project VMs need hardware virtualization for this host's architecture; there is none here (arm64 Windows has no hypervisor QEMU can use)."
                .to_string(),
        );
    } else {
        if !p.qemu {
            reasons.push(format!(
                "'{}' not found. {}",
                GuestArch::host().qemu_binary(),
                qemu_install_hint()
            ));
        }
        if !p.kvm {
            reasons.push(p.kvm_reason.clone().unwrap_or_else(|| {
                "/dev/kvm is not accessible. Enable virtualization in firmware and add your user to the 'kvm' group."
                    .to_string()
            }));
        }
        if !p.qemu_img {
            reasons.push("'qemu-img' not found (it ships with QEMU).".to_string());
        }
        if !p.firmware_ok {
            reasons.push(
                "No arm64 UEFI firmware (edk2-aarch64-code.fd) found; it ships with QEMU's firmware package."
                    .to_string(),
            );
        }
        if p.iso_tool.is_none() {
            reasons.push(
                "No cloud-init seed tool found. Install one of: genisoimage, mkisofs, xorriso, or cloud-image-utils (cloud-localds)."
                    .to_string(),
            );
        }
        if let Some(free) = p.disk_free_gb {
            if free < 8 {
                reasons.push(format!(
                    "Low disk space in the {app} state dir ({free} GiB free); a VM overlay can grow to tens of GiB.", app = crate::brand::DISPLAY
                ));
            }
        }
    }
    let ok = p.supported && p.qemu && p.kvm && p.qemu_img && p.iso_tool.is_some() && p.firmware_ok;
    VmDoctorReport {
        supported: p.supported,
        ok,
        qemu: p.qemu,
        kvm: p.kvm,
        qemu_img: p.qemu_img,
        iso_tool: p.iso_tool.clone(),
        disk_free_gb: p.disk_free_gb,
        base_image_ready: p.base_image_ready,
        baked_image_ready: p.baked_image_ready,
        reasons,
        fetch_command: None,
        bake_command: None,
        install_command: install_command_for(HostOs::current(), GuestArch::host(), p),
    }
}

fn binary_ok(bin: &str, arg: &str) -> bool {
    crate::paths::command_no_window(bin)
        .arg(arg)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Which external ISO tool builds the seed, in preference order. The style
/// decides the argv shape ([`seed_iso_args`]). `None` means the built-in
/// writer ([`BUILTIN_ISO_TOOL`]) is used — always the case on macOS and
/// Windows, where none of these ship.
pub fn pick_iso_tool() -> Option<&'static str> {
    ["genisoimage", "mkisofs", "xorriso", "cloud-localds"]
        .into_iter()
        .find(|tool| crate::paths::resolve_executable(tool).is_some())
}

/// The doctor's name for the in-process ISO 9660 writer.
pub const BUILTIN_ISO_TOOL: &str = "built-in";

/// The seed tool actually used: an installed external one, else the built-in.
fn seed_tool() -> &'static str {
    pick_iso_tool().unwrap_or(BUILTIN_ISO_TOOL)
}

/// Author `seed.iso` in `seed_dir` from its `user-data` + `meta-data`, with
/// `tool` — an external mkisofs-style binary run in that directory, or the
/// built-in writer.
fn write_seed_iso(seed_dir: &Path, tool: &str) -> Result<(), String> {
    if tool == BUILTIN_ISO_TOOL {
        let user_data = std::fs::read(seed_dir.join("user-data")).map_err(|e| e.to_string())?;
        let meta_data = std::fs::read(seed_dir.join("meta-data")).map_err(|e| e.to_string())?;
        let image = crate::services::iso9660::write_iso(
            "cidata",
            &[("user-data", &user_data), ("meta-data", &meta_data)],
        )?;
        return std::fs::write(seed_dir.join("seed.iso"), image).map_err(|e| e.to_string());
    }
    let out = crate::paths::command_no_window(tool)
        .args(seed_iso_args(tool))
        .current_dir(seed_dir)
        .output()
        .map_err(|e| format!("{tool}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{tool} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

/// The argv (after the binary) that authors `seed.iso` from `user-data` +
/// `meta-data` in the current directory. Pure.
pub fn seed_iso_args(tool: &str) -> Vec<String> {
    let mkisofs_style = [
        "-output",
        "seed.iso",
        "-volid",
        "cidata",
        "-joliet",
        "-rock",
        "user-data",
        "meta-data",
    ];
    match tool {
        "xorriso" => {
            let mut args = vec!["-as".to_string(), "mkisofs".to_string()];
            args.extend(mkisofs_style.iter().map(|s| s.to_string()));
            args
        }
        "cloud-localds" => ["seed.iso", "user-data", "meta-data"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        _ => mkisofs_style.iter().map(|s| s.to_string()).collect(),
    }
}

/// Is the host hypervisor usable? Linux: `/dev/kvm` opens read-write. macOS:
/// `kern.hv_support` (Hypervisor.framework) is on. Windows: this QEMU was
/// built with WHPX (whether the *Windows Hypervisor Platform* feature is
/// enabled only shows at boot, and QEMU's own error is then surfaced).
fn probe_accel() -> (bool, Option<String>) {
    #[cfg(target_os = "macos")]
    {
        let mut value: i32 = 0;
        let mut size = std::mem::size_of::<i32>();
        // SAFETY: `sysctlbyname` writes at most `size` bytes into `value`.
        let rc = unsafe {
            libc::sysctlbyname(
                c"kern.hv_support".as_ptr(),
                &mut value as *mut i32 as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && value == 1 {
            return (true, None);
        }
        (
            false,
            Some(
                "Hypervisor.framework is not available on this Mac (kern.hv_support is 0); project VMs need it."
                    .to_string(),
            ),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let bin = GuestArch::host().qemu_binary();
        let listed = crate::paths::command_no_window(bin)
            .args(["-accel", "help"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("whpx"))
            .unwrap_or(false);
        if listed {
            return (true, None);
        }
        (
            false,
            Some(
                "QEMU reports no WHPX accelerator. Install the official QEMU for Windows and turn on 'Windows Hypervisor Platform' under Windows Features."
                    .to_string(),
            ),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        probe_kvm()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn probe_kvm() -> (bool, Option<String>) {
    #[cfg(target_os = "linux")]
    {
        let path = Path::new("/dev/kvm");
        if !path.exists() {
            return (
                false,
                Some(
                    "/dev/kvm does not exist — enable VT-x/AMD-V in firmware (and the kvm modules)."
                        .to_string(),
                ),
            );
        }
        match std::fs::OpenOptions::new().read(true).write(true).open(path) {
            Ok(_) => (true, None),
            Err(e) => (
                false,
                Some(format!(
                    "/dev/kvm exists but is not accessible ({e}). Add your user to the 'kvm' group and re-login."
                )),
            ),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        (false, None)
    }
}

/// Free space of the filesystem holding `dir`, in GiB — the same
/// `statvfs`/`GetDiskFreeSpaceEx` read the disk-usage pane uses.
fn disk_free_gb(dir: &Path) -> Option<u64> {
    crate::duscan::capacity_of(dir).map(|(_, avail)| avail / (1024 * 1024 * 1024))
}

/// Run the full doctor probe. Slowish (a few process spawns) — call from
/// `spawn_blocking`.
pub fn doctor() -> VmDoctorReport {
    let arch = GuestArch::host();
    let supported = machine_args_for(HostOs::current(), arch, None).is_some();
    let (kvm, kvm_reason) = if supported {
        probe_accel()
    } else {
        (false, None)
    };
    let probes = VmDoctorProbes {
        supported,
        qemu: supported && binary_ok(arch.qemu_binary(), "--version"),
        kvm,
        kvm_reason,
        qemu_img: supported && binary_ok("qemu-img", "--version"),
        iso_tool: supported.then(|| seed_tool().to_string()),
        disk_free_gb: if supported {
            let root = vm_root();
            let _ = std::fs::create_dir_all(&root);
            disk_free_gb(&root)
        } else {
            None
        },
        base_image_ready: base_image_path().is_some(),
        baked_image_ready: baked_image_path().is_file(),
        firmware_ok: !arch.needs_firmware() || find_aarch64_firmware().is_some(),
    };
    let mut report = doctor_verdict(&probes);
    if report.ok && !report.base_image_ready {
        report.fetch_command = fetch_base_command().ok();
    }
    if report.ok && report.base_image_ready && !report.baked_image_ready {
        report.bake_command = build_base_command().ok();
    }
    report
}

// ── Base image: fetch + bake (build-tab commands) ──────────────────────────

/// Write the checksum-verified stock-image fetch script and return the
/// build-tab command that runs it (same UX as the sandbox's missing-image
/// build: one click, streamed output, never copy-it-yourself).
pub fn fetch_base_command() -> Result<String, String> {
    let images = images_dir();
    std::fs::create_dir_all(&images).map_err(|e| e.to_string())?;
    let arch = GuestArch::host();
    let name = arch.stock_image_name();
    let url = format!("{STOCK_RELEASE_URL}/{name}");
    if cfg!(windows) {
        // PowerShell twin: BITS-free download, SHA-256 from the release's own
        // SHA256SUMS, atomic rename — the same steps as the bash script.
        let script = format!(
            r#"$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '{images}'
Write-Output '── Fetching Ubuntu 24.04 cloud image (~600 MB) ──'
Invoke-WebRequest -Uri '{url}' -OutFile '{name}.part'
Write-Output '── Verifying checksum ──'
Invoke-WebRequest -Uri '{sums}' -OutFile 'SHA256SUMS'
$expected = Get-Content 'SHA256SUMS' | Where-Object {{ $_ -match '\s\*?{name}$' }} | ForEach-Object {{ ($_ -split '\s+')[0] }} | Select-Object -First 1
if (-not $expected) {{ throw 'SHA256SUMS has no entry for {name}' }}
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath '{name}.part').Hash.ToLower()
if ($actual -ne $expected.ToLower()) {{ throw "checksum mismatch: $actual != $expected" }}
Move-Item -Force -LiteralPath '{name}.part' -Destination '{name}'
Write-Output '── Base image ready. New VM projects can boot now. ──'
"#,
            images = images.display(),
            name = name,
            url = url,
            sums = STOCK_SUMS_URL,
        );
        let path = vm_root().join("fetch-base.ps1");
        std::fs::write(&path, script).map_err(|e| e.to_string())?;
        return Ok(format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File '{}'",
            path.display()
        ));
    }
    let script = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
cd '{images}'
echo '── Fetching Ubuntu 24.04 cloud image (~600 MB) ──'
curl -fL --progress-bar -o '{name}.part' '{url}'
echo '── Verifying checksum ──'
curl -fsSL -o SHA256SUMS '{sums}'
awk -v f='{name}' '($2 == f || $2 == "*" f) {{ print $1 "  " f ".part" }}' SHA256SUMS | {sha256} -c -
mv '{name}.part' '{name}'
echo '── Base image ready. New VM projects can boot now. ──'
"#,
        images = images.display(),
        name = name,
        url = url,
        sums = STOCK_SUMS_URL,
        // macOS has no `sha256sum`; `shasum -a 256` reads the same `-c` format.
        sha256 = if cfg!(target_os = "macos") {
            "shasum -a 256"
        } else {
            "sha256sum"
        },
    );
    let path = vm_root().join("fetch-base.sh");
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    Ok(format!("bash '{}'", path.display()))
}

/// The provisioning cloud-config the bake boots with: install the agent
/// toolchain, then power down. Pure so the recipe is testable.
pub fn bake_user_data() -> String {
    // node via NodeSource keeps the npm-installed agent CLIs current enough;
    // the stock 24.04 nodejs is fine for all three CLIs today, so stay with
    // the distro package — fewer moving parts inside the trust boundary.
    concat!(r#"#cloud-config
package_update: true
packages:
  - git
  - build-essential
  - tmux
  - nodejs
  - npm
  - python3
  - python3-venv
runcmd:
  - [sh, -c, "npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli || true"]
  - [sh, -c, "echo "#, crate::app_upper!(), r#"_BAKE_DONE"]
power_state:
  mode: poweroff
  timeout: 60
"#)
    .to_string()
}

/// Write the bake script + provisioning seed inputs and return the build-tab
/// command. The bake boots the stock image once with `-serial stdio`, so the
/// guest's own cloud-init output streams into the tab as build progress;
/// cloud-init powers the VM off when done and the script converts the overlay
/// into `tabtivity-base-<ver>.qcow2`.
pub fn build_base_command() -> Result<String, String> {
    let root = vm_root();
    let bake = root.join("bake");
    std::fs::create_dir_all(&bake).map_err(|e| e.to_string())?;
    std::fs::write(bake.join("user-data"), bake_user_data()).map_err(|e| e.to_string())?;
    std::fs::write(
        bake.join("meta-data"),
        cloud_init_meta_data(concat!(crate::app_slug!(), "-bake"), concat!(crate::app_slug!(), "-bake")),
    )
    .map_err(|e| e.to_string())?;
    let tool = seed_tool();
    // The built-in writer has no command line: the seed is authored here, now,
    // and the script only boots it. An external tool runs inside the script
    // so its output streams into the build tab like the rest.
    let iso_line = if tool == BUILTIN_ISO_TOOL {
        let _ = std::fs::remove_file(bake.join("seed.iso"));
        write_seed_iso(&bake, tool)?;
        concat!("# seed.iso was written by ", crate::app_name!(), "'s built-in ISO 9660 writer").to_string()
    } else {
        let argv = seed_iso_args(tool)
            .iter()
            .map(|a| format!("'{a}'"))
            .collect::<Vec<_>>()
            .join(" ");
        format!("rm -f seed.iso; {tool} {argv}")
    };
    let arch = GuestArch::host();
    let qemu = crate::paths::resolve_executable(arch.qemu_binary())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| arch.qemu_binary().to_string());
    let machine = machine_args()?.join(" ");
    if cfg!(windows) {
        let script = format!(
            concat!(r#"$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '{bake}'
Write-Output '── Building the "#, crate::app_name!(), r#" VM base image (installs git, build tools, node, agent CLIs) ──'
Remove-Item -Force -ErrorAction SilentlyContinue disk.qcow2
{iso_line}
& qemu-img create -f qcow2 -b '{stock}' -F qcow2 disk.qcow2 32G
Write-Output '── Booting provisioning VM (5–10 min; console output follows) ──'
& '{qemu}' {machine} -m 4096 -smp 2 -drive file=disk.qcow2,if=virtio,format=qcow2 -drive file=seed.iso,if=virtio,media=cdrom,format=raw,readonly=on -netdev user,id=net0 -device virtio-net-pci,netdev=net0 -display none -serial stdio
Write-Output '── Converting to base image ──'
& qemu-img convert -O qcow2 disk.qcow2 '{baked}.part'
Move-Item -Force -LiteralPath '{baked}.part' -Destination '{baked}'
Remove-Item -Force -ErrorAction SilentlyContinue disk.qcow2, seed.iso
Write-Output '── Baked base image ready: {baked} ──'
Write-Output '   New VM projects boot from it; existing VMs keep their current disk.'
"#),
            bake = bake.display(),
            iso_line = iso_line,
            qemu = qemu,
            machine = machine,
            stock = stock_image_path().display(),
            baked = baked_image_target().display(),
        );
        let path = root.join("bake-base.ps1");
        std::fs::write(&path, script).map_err(|e| e.to_string())?;
        return Ok(format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File '{}'",
            path.display()
        ));
    }
    let script = format!(
        concat!(r#"#!/usr/bin/env bash
set -euo pipefail
cd '{bake}'
echo '── Building the "#, crate::app_name!(), r#" VM base image (installs git, build tools, node, agent CLIs) ──'
rm -f disk.qcow2
{iso_line}
qemu-img create -f qcow2 -b '{stock}' -F qcow2 disk.qcow2 32G
echo '── Booting provisioning VM (5–10 min; console output follows) ──'
'{qemu}' {machine} -m 4096 -smp 2 \
  -drive file=disk.qcow2,if=virtio,format=qcow2 \
  -drive file=seed.iso,if=virtio,media=cdrom,format=raw,readonly=on \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -display none -serial stdio
echo '── Converting to base image ──'
qemu-img convert -O qcow2 disk.qcow2 '{baked}.part'
mv '{baked}.part' '{baked}'
rm -f disk.qcow2 seed.iso
echo '── Baked base image ready: {baked} ──'
echo '   New VM projects boot from it; existing VMs keep their current disk.'
"#),
        bake = bake.display(),
        iso_line = iso_line,
        qemu = qemu,
        machine = machine,
        stock = stock_image_path().display(),
        baked = baked_image_target().display(),
    );
    let path = root.join("bake-base.sh");
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    Ok(format!("bash '{}'", path.display()))
}

// ── cloud-init seed (per project) ──────────────────────────────────────────

/// Guest-safe hostname from a project name: ASCII alphanumerics and dashes.
/// The names a VM's guest was set up with: its account, its project folder,
/// and the names cloud-init wrote files and its instance id under.
///
/// They are fixed when a VM is created and must never change afterwards.
/// cloud-init runs "first boot" again whenever the instance id moves, and the
/// id is computed at every boot from a prefix and a hash of the user-data —
/// which itself names the account, the folder and two files. So an existing
/// VM is always seeded with the names it was created under, whatever the app
/// is called now; only a VM created by this build gets the current ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmNames {
    /// The guest account.
    pub user: String,
    /// The project's folder in the guest.
    pub project_dir: String,
    /// In the names of the files cloud-init writes.
    pub slug: String,
    /// What the instance id starts with.
    pub instance_prefix: String,
    /// The hostname of a project whose name has no usable character.
    pub default_hostname: String,
}

impl VmNames {
    /// The names a build called `forms` gives a VM it creates.
    pub fn of(forms: &crate::brand::Forms) -> Self {
        use crate::brand::Name;
        Self {
            user: forms.name(Name::VM_USER),
            project_dir: forms.name(Name::VM_PROJECT_DIR),
            slug: forms.slug.to_string(),
            instance_prefix: forms.name(Name::VM_INSTANCE_ID_PREFIX),
            default_hostname: forms.name(Name::VM_NAME),
        }
    }

    /// The names of the VM whose project record stores `guest_user` as its
    /// SSH user (written once, when the project was created): the old names
    /// for a VM an older build created, the current ones otherwise.
    pub fn of_existing(pair: &crate::brand::Pair, guest_user: Option<&str>) -> Self {
        match (guest_user, pair.legacy(crate::brand::Name::VM_USER)) {
            (Some(user), Some(old_user)) if user == old_user => Self::of(&pair.legacy),
            _ => Self::of(&pair.cur),
        }
    }

    /// The names of project `project_id`'s VM, from its stored record.
    fn of_project(project_id: &str) -> Self {
        let pair = crate::brand::PAIR;
        if !pair.renamed() {
            return Self::of(&pair.cur);
        }
        let user = crate::services::remote::remote_target_for(project_id).and_then(|target| target.spec.user);
        Self::of_existing(&pair, user.as_deref())
    }
}

pub fn vm_hostname(project_name: &str) -> String {
    vm_hostname_for(&VmNames::of(&crate::brand::CURRENT), project_name)
}

fn vm_hostname_for(names: &VmNames, project_name: &str) -> String {
    let mut out = String::new();
    for c in project_name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if (c == '-' || c == ' ' || c == '_') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        names.default_hostname.clone()
    } else {
        let mut name = String::from("vm-");
        name.push_str(&trimmed.chars().take(24).collect::<String>());
        name.trim_end_matches('-').to_string()
    }
}

/// The per-project NoCloud `user-data`: the `tabtivity` account with the per-VM
/// public key, the project dir, and — under `Proxy` egress — the proxy env
/// pointing at the fixed guest-side `guestfwd` address. Pure.
pub fn cloud_init_user_data(hostname: &str, pubkey: &str, proxy: bool) -> String {
    cloud_init_user_data_for(&VmNames::of(&crate::brand::CURRENT), hostname, pubkey, proxy)
}

/// [`cloud_init_user_data`] with the names of the VM it is for.
fn cloud_init_user_data_for(names: &VmNames, hostname: &str, pubkey: &str, proxy: bool) -> String {
    let slug = names.slug.as_str();
    let mut doc = format!(
        r#"#cloud-config
hostname: {hostname}
users:
  - name: {user}
    shell: /bin/bash
    groups: [sudo]
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    lock_passwd: true
    ssh_authorized_keys:
      - {pubkey}
ssh_pwauth: false
"#,
        hostname = hostname,
        user = names.user,
        pubkey = pubkey.trim(),
    );
    if proxy {
        let addr = crate::services::vm_proxy::GUEST_PROXY_ADDR;
        doc.push_str(&format!(
            r#"write_files:
  - path: /etc/profile.d/{slug}-proxy.sh
    permissions: '0644'
    content: |
      export http_proxy=http://{addr}
      export https_proxy=http://{addr}
      export HTTP_PROXY=http://{addr}
      export HTTPS_PROXY=http://{addr}
      export no_proxy=localhost,127.0.0.1,::1
      export NO_PROXY=localhost,127.0.0.1,::1
  - path: /etc/apt/apt.conf.d/95{slug}-proxy
    permissions: '0644'
    content: |
      Acquire::http::Proxy "http://{addr}";
      Acquire::https::Proxy "http://{addr}";
"#,
        ));
    }
    doc.push_str(&format!(
        r#"runcmd:
  - mkdir -p {dir}
  - chown {user}:{user} {dir}
"#,
        dir = names.project_dir,
        user = names.user,
    ));
    if proxy {
        let addr = crate::services::vm_proxy::GUEST_PROXY_ADDR;
        doc.push_str(&format!(
            "  - [sh, -c, \"printf 'http_proxy=http://{addr}\\nhttps_proxy=http://{addr}\\nHTTP_PROXY=http://{addr}\\nHTTPS_PROXY=http://{addr}\\nno_proxy=localhost,127.0.0.1,::1\\nNO_PROXY=localhost,127.0.0.1,::1\\n' >> /etc/environment\"]\n",
        ));
    }
    doc
}

/// NoCloud `meta-data`. The instance id folds in the user-data's content hash
/// ([`seed_instance_id`]) so an egress-mode change re-runs cloud-init's
/// per-instance modules on the next boot instead of being silently ignored.
pub fn cloud_init_meta_data(instance_id: &str, hostname: &str) -> String {
    format!("instance-id: {instance_id}\nlocal-hostname: {hostname}\n")
}

/// Instance id for a seed: stable while the config is, new when it changes.
pub fn seed_instance_id(project_id: &str, user_data: &str) -> String {
    seed_instance_id_for(&VmNames::of(&crate::brand::CURRENT), project_id, user_data)
}

fn seed_instance_id_for(names: &VmNames, project_id: &str, user_data: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(user_data.as_bytes());
    let digest = hasher.finalize();
    let hash_hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let id8: String = project_id.chars().take(8).collect();
    format!("{}{id8}-{hash_hex}", names.instance_prefix)
}

// ── QEMU argv (pure builders) ──────────────────────────────────────────────

/// The `-netdev user,…` argument for an egress mode. `Off` and `Proxy` set
/// slirp `restrict=on` (guest is isolated from host and world; the explicit
/// `hostfwd`/`guestfwd` rules still work — that is documented slirp behavior
/// and the entire point: ssh in via the forward, and under Proxy exactly one
/// way out, through the allowlisting CONNECT proxy).
///
/// `mcp_port` is the host's root-MCP port, given only for a `mail_reader`
/// project under `Proxy`: a second `guestfwd` beside the proxy's, at the fixed
/// guest-side address the reader's in-guest MCP config names
/// (`root_mcp::READER_GUEST_HOST`). The listener's `Origin` refusal and bearer
/// check are unchanged; the channel only makes the port reachable.
pub fn netdev_arg(egress: VmEgress, ssh_port: u16, proxy_port: Option<u16>, mcp_port: Option<u16>) -> String {
    let base = format!("user,id=net0,hostfwd=tcp:127.0.0.1:{ssh_port}-:22");
    match egress {
        VmEgress::Open => base,
        VmEgress::Off => format!("{base},restrict=on"),
        VmEgress::Proxy => {
            let proxy = proxy_port.expect("Proxy egress requires a proxy port");
            let guest = crate::services::vm_proxy::GUEST_PROXY_ADDR;
            let mcp = mcp_port
                .map(|port| {
                    use crate::services::root_mcp::{READER_GUEST_HOST, READER_GUEST_PORT};
                    format!(",guestfwd=tcp:{READER_GUEST_HOST}:{READER_GUEST_PORT}-tcp:127.0.0.1:{port}")
                })
                .unwrap_or_default();
            format!("{base},restrict=on,guestfwd=tcp:{guest}-tcp:127.0.0.1:{proxy}{mcp}")
        }
    }
}

/// The `-qmp` endpoint: a Unix socket in the VM dir, or on Windows a loopback
/// TCP port (no `AF_UNIX` in Windows QEMU).
pub fn qmp_endpoint(qmp_sock: &Path, qmp_port: Option<u16>) -> String {
    match qmp_port {
        Some(port) => format!("tcp:127.0.0.1:{port},server=on,wait=off"),
        None => format!("unix:{},server=on,wait=off", qmp_sock.display()),
    }
}

/// Full QEMU argv (after the binary) for a project VM boot. Pure. `machine` is
/// [`machine_args_for`]'s accelerator/machine/CPU triple; `daemonize` is false
/// on Windows, whose QEMU refuses `-daemonize` (the caller spawns detached and
/// polls the pidfile instead).
#[allow(clippy::too_many_arguments)]
pub fn qemu_args(
    machine: &[String],
    memory_mb: u32,
    cpus: u32,
    disk: &Path,
    seed: &Path,
    netdev: &str,
    pidfile: &Path,
    qmp: &str,
    serial_log: &Path,
    daemonize: bool,
) -> Vec<String> {
    let mut args: Vec<String> = machine.to_vec();
    args.extend([
        "-m".to_string(),
        memory_mb.to_string(),
        "-smp".to_string(),
        cpus.to_string(),
        "-drive".to_string(),
        format!(
            "file={},if=virtio,format=qcow2,discard=unmap",
            disk.display()
        ),
        "-drive".to_string(),
        format!(
            "file={},if=virtio,media=cdrom,format=raw,readonly=on",
            seed.display()
        ),
        "-netdev".to_string(),
        netdev.to_string(),
        "-device".to_string(),
        "virtio-net-pci,netdev=net0".to_string(),
        "-display".to_string(),
        "none".to_string(),
    ]);
    if daemonize {
        args.push("-daemonize".to_string());
    }
    args.extend([
        "-pidfile".to_string(),
        pidfile.display().to_string(),
        "-qmp".to_string(),
        qmp.to_string(),
        "-serial".to_string(),
        format!("file:{}", serial_log.display()),
    ]);
    args
}

// ── Boot ───────────────────────────────────────────────────────────────────

fn alloc_loopback_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("no free loopback port: {e}"))
}

fn ensure_keypair(dir: &Path) -> Result<String, String> {
    let key = dir.join("id_ed25519");
    if !key.exists() {
        let out = crate::paths::command_no_window("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", crate::brand::VM_NAME, "-f"])
            .arg(&key)
            .output()
            .map_err(|e| format!("ssh-keygen: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ssh-keygen failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    std::fs::read_to_string(dir.join("id_ed25519.pub"))
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("read VM public key: {e}"))
}

fn ensure_overlay(dir: &Path, disk_gb: u32) -> Result<(PathBuf, String), String> {
    let disk = dir.join("disk.qcow2");
    let base = base_image_path().ok_or_else(|| {
        "No VM base image yet. Run the one-click fetch from the VM doctor / creation dialog first."
            .to_string()
    })?;
    if !disk.exists() {
        let out = crate::paths::command_no_window("qemu-img")
            .args(["create", "-f", "qcow2", "-b"])
            .arg(&base)
            .args(["-F", "qcow2"])
            .arg(&disk)
            .arg(format!("{disk_gb}G"))
            .output()
            .map_err(|e| format!("qemu-img: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "qemu-img create failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    Ok((disk, base.display().to_string()))
}

fn ensure_seed(
    dir: &Path,
    names: &VmNames,
    project_id: &str,
    hostname: &str,
    pubkey: &str,
    proxy: bool,
) -> Result<PathBuf, String> {
    let seed_dir = dir.join("seed");
    std::fs::create_dir_all(&seed_dir).map_err(|e| e.to_string())?;
    let user_data = cloud_init_user_data_for(names, hostname, pubkey, proxy);
    let meta_data = cloud_init_meta_data(&seed_instance_id_for(names, project_id, &user_data), hostname);
    let iso = dir.join("seed.iso");

    // Rebuild only when the inputs changed — the iso is consumed on every
    // boot, but cloud-init re-applies per-instance config only when the
    // instance id moves, so a stable config keeps a stable seed.
    let stale = std::fs::read_to_string(seed_dir.join("user-data"))
        .map(|prev| prev != user_data)
        .unwrap_or(true);
    if stale || !iso.is_file() {
        std::fs::write(seed_dir.join("user-data"), &user_data).map_err(|e| e.to_string())?;
        std::fs::write(seed_dir.join("meta-data"), &meta_data).map_err(|e| e.to_string())?;
        write_seed_iso(&seed_dir, seed_tool())?;
        std::fs::rename(seed_dir.join("seed.iso"), &iso).map_err(|e| e.to_string())?;
    }
    Ok(iso)
}

/// Rewrite the project's `RemoteSpec` endpoint (host/port/key_auth/vm marker)
/// in BOTH `projects.json` (the always-local truth every resolver reads) and
/// the project's own `project.json` — before anything connects. Ports are
/// per-boot; this is the one writer.
fn record_vm_endpoint(project_id: &str, ssh_port: u16) -> Result<(), String> {
    crate::commands::projects::patch_project_entry_mirrored(
        project_id,
        |entry| {
            let mut spec: RemoteSpec = entry
                .extra
                .get("remote")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .ok_or_else(|| format!("VM project '{project_id}' has no remote spec"))?;
            spec.host = "127.0.0.1".to_string();
            spec.port = Some(ssh_port);
            spec.key_auth = Some(true);
            spec.vm = Some(true);
            entry.extra.insert(
                "remote".to_string(),
                serde_json::to_value(&spec).map_err(|e| e.to_string())?,
            );
            Ok(spec)
        },
        |project, spec| project.remote = Some(spec.clone()),
    )?;
    Ok(())
}

/// Poll the forwarded port until sshd answers with its banner (or time out).
/// First boot includes cloud-init user creation + host-key generation, so the
/// window is generous; a warm boot answers in seconds.
fn wait_ssh_ready(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    while Instant::now() < deadline {
        if let Ok(mut conn) =
            std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(800))
        {
            let _ = conn.set_read_timeout(Some(Duration::from_secs(3)));
            let mut buf = [0u8; 4];
            if let Ok(n) = conn.read(&mut buf) {
                if n >= 4 && &buf[..4] == b"SSH-" {
                    return Ok(());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    Err(format!(
        "VM did not become reachable on 127.0.0.1:{port} within {}s (see serial.log in the VM state dir)",
        timeout.as_secs()
    ))
}

/// Boot the project's VM if it isn't running, and return the live runtime.
/// Idempotent; blocking (call from `spawn_blocking`). On success the
/// project's `RemoteSpec` already points at the fresh forwarded port and sshd
/// has answered — `remote_connect` can proceed immediately.
pub fn ensure_booted(project_id: &str, project_name: &str) -> Result<VmRuntime, String> {
    let lock = boot_lock_for(project_id);
    let _guard = lock.lock().unwrap();

    if let Some(runtime) = running_state(project_id) {
        return Ok(runtime);
    }
    // Not (live-)registered: clear any stale entry.
    registry().lock().unwrap().remove(project_id);

    let spec = vm_spec_for(project_id)
        .ok_or_else(|| format!("project '{project_id}' has no VM config"))?;
    if !spec.enabled {
        return Err("This project's VM is disabled.".to_string());
    }

    let dir = vm_dir(project_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let pubkey = ensure_keypair(&dir)?;
    let (disk, base_image) = ensure_overlay(&dir, spec.disk_gb)?;

    // Egress proxy first — the seed bakes whether proxy env exists, and the
    // netdev needs the listener's port.
    let proxy_port = match spec.egress {
        VmEgress::Proxy => Some(crate::services::vm_proxy::ensure_proxy(
            project_id,
            crate::services::vm_proxy::allowlist_for(&spec.allow_hosts, spec.allow_github),
        )?),
        _ => None,
    };

    // The names this VM was created under (see [`VmNames`]): they decide
    // the seed, and so whether cloud-init sees the instance it already set up.
    let names = VmNames::of_project(project_id);
    let hostname = vm_hostname_for(&names, project_name);
    let seed = ensure_seed(
        &dir,
        &names,
        project_id,
        &hostname,
        &pubkey,
        matches!(spec.egress, VmEgress::Proxy),
    )?;

    let ssh_port = alloc_loopback_port()?;
    let pidfile = dir.join("qemu.pid");
    let qmp_sock = dir.join("qmp.sock");
    let serial_log = dir.join("serial.log");
    let _ = std::fs::remove_file(&pidfile);
    let _ = std::fs::remove_file(&qmp_sock);
    let qmp_port = if cfg!(windows) {
        Some(alloc_loopback_port()?)
    } else {
        None
    };

    // Only a flagged reader gets the channel to the root MCP port, and only
    // while the listener is up; every other VM has no route to it at all.
    let mcp_port = spec
        .mail_reader
        .then(|| crate::services::root_mcp::runtime().filter(|rt| rt.serves_root).map(|rt| rt.port))
        .flatten();
    let netdev = netdev_arg(spec.egress, ssh_port, proxy_port, mcp_port);
    let machine = machine_args()?;
    let daemonize = !cfg!(windows);
    let args = qemu_args(
        &machine,
        spec.memory_mb,
        spec.cpus,
        &disk,
        &seed,
        &netdev,
        &pidfile,
        &qmp_endpoint(&qmp_sock, qmp_port),
        &serial_log,
        daemonize,
    );
    let qemu = GuestArch::host().qemu_binary();
    let pid = if daemonize {
        let out = crate::paths::command_no_window(qemu)
            .args(&args)
            .output()
            .map_err(|e| format!("{qemu}: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "QEMU failed to start: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        // `-daemonize`: the parent exits once the daemon is up and the pidfile
        // is written.
        read_pidfile(&pidfile)?
    } else {
        // Windows: no `-daemonize`. Spawn detached (the handle is dropped; a
        // Windows child outlives its parent's handle) and wait for QEMU to
        // write its own pidfile, which it does once the machine is created —
        // a start-up failure shows as the process exiting without one.
        let mut child = crate::paths::command_no_window(qemu)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("{qemu}: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(pid) = read_pidfile(&pidfile) {
                break pid;
            }
            if let Ok(Some(status)) = child.try_wait() {
                let mut err = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut err);
                }
                return Err(format!("QEMU failed to start ({status}): {}", err.trim()));
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err("QEMU did not write its pidfile within 20s".to_string());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    };

    let runtime = VmRuntime {
        pid,
        ssh_port,
        proxy_port,
        qmp_port,
        egress: spec.egress,
        base_image,
    };
    storage::write_json(&dir.join("vm.json"), &runtime).map_err(|e| e.to_string())?;
    registry().lock().unwrap().insert(
        project_id.to_string(),
        RunningVm {
            dir: dir.clone(),
            runtime: runtime.clone(),
        },
    );
    // The endpoint must be recorded before readiness: a parallel caller that
    // sees the registry entry may resolve the spec at any point from here.
    record_vm_endpoint(project_id, ssh_port)?;

    if let Err(e) = wait_ssh_ready(ssh_port, Duration::from_secs(180)) {
        // A VM that never answered is torn down rather than left half-up: the
        // next attempt starts clean, and no stale registry entry keeps
        // authorizing ssh options for a dead port.
        shutdown(project_id);
        return Err(e);
    }
    Ok(runtime)
}

// ── Shutdown / sweep ───────────────────────────────────────────────────────

fn read_pidfile(pidfile: &Path) -> Result<u32, String> {
    std::fs::read_to_string(pidfile)
        .map_err(|e| format!("read qemu pidfile: {e}"))?
        .trim()
        .parse()
        .map_err(|_| "unparseable qemu pidfile".to_string())
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        crate::commands::apps::pid_alive(pid)
    }
}

/// Whether `pid` is a live process that is (still) **our** QEMU.
///
/// The `comm` half is the rule `sweep_orphans` already states — a recycled pid
/// must never be signalled — applied wherever a pid read from the registry or a
/// pidfile is acted on. Both outlive the process they name: a QEMU killed from
/// outside clears neither, so the record can point at whatever the kernel later
/// gives that number.
fn pid_is_live_qemu(pid: u32) -> bool {
    pid_alive(pid) && process_is_qemu(pid)
}

#[cfg(unix)]
fn signal_pid(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

/// Windows has no signals: the escalation past a refused ACPI powerdown is a
/// forced termination (`taskkill /F`), which is what SIGKILL is on Unix.
#[cfg(windows)]
fn terminate_pid(pid: u32) {
    let _ = crate::paths::command_no_window("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output();
}

/// Greeting → capabilities negotiation → `system_powerdown`, over any QMP
/// stream. Replies are read loosely; only acceptance of the command matters.
fn qmp_session<S: Read + Write>(conn: &mut S) -> Result<(), String> {
    let mut buf = [0u8; 1024];
    let _ = conn.read(&mut buf);
    conn.write_all(b"{\"execute\":\"qmp_capabilities\"}\n")
        .map_err(|e| e.to_string())?;
    let _ = conn.read(&mut buf);
    conn.write_all(b"{\"execute\":\"system_powerdown\"}\n")
        .map_err(|e| e.to_string())?;
    let _ = conn.read(&mut buf);
    Ok(())
}

/// Ask QEMU for an ACPI powerdown over its QMP endpoint — the Unix socket in
/// the VM dir, or the loopback port `vm.json` recorded on Windows. Best-effort:
/// any failure falls through to the process escalation.
fn qmp_powerdown(sock: &Path, qmp_port: Option<u16>) -> Result<(), String> {
    if let Some(port) = qmp_port {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut conn = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        conn.set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        conn.set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        return qmp_session(&mut conn);
    }
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixStream;
        let mut conn = UnixStream::connect(sock).map_err(|e| e.to_string())?;
        conn.set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        conn.set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        qmp_session(&mut conn)
    }
    #[cfg(not(unix))]
    {
        let _ = sock;
        Err("no QMP endpoint recorded".to_string())
    }
}

fn wait_pid_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    !pid_alive(pid)
}

fn teardown_runtime_files(dir: &Path) {
    for name in ["qemu.pid", "qmp.sock", "vm.json"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// Shut the project's VM down: ACPI powerdown via QMP, escalate to SIGTERM
/// then SIGKILL after a grace period. Idempotent; also stops the egress
/// proxy and clears runtime state.
pub fn shutdown(project_id: &str) {
    let removed = registry().lock().unwrap().remove(project_id);
    let dir = removed
        .as_ref()
        .map(|vm| vm.dir.clone())
        .unwrap_or_else(|| vm_dir(project_id));
    // The QMP port (Windows) comes from the registry, else from the vm.json a
    // crashed predecessor left behind.
    let qmp_port = removed
        .as_ref()
        .and_then(|vm| vm.runtime.qmp_port)
        .or_else(|| {
            storage::read_json::<VmRuntime>(&dir.join("vm.json"))
                .ok()
                .and_then(|r| r.qmp_port)
        });
    let pid = removed.map(|vm| vm.runtime.pid).or_else(|| {
        std::fs::read_to_string(dir.join("qemu.pid"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
    });

    // `pid_is_live_qemu`, not `pid_alive`: this pid can come from a `qemu.pid`
    // file (or a registry entry) that outlived its process — a QEMU killed from
    // outside clears neither — and the number may since have been recycled onto
    // something innocent. `sweep_orphans` has always checked; a deactivate,
    // archive or project delete signalled whatever the file said.
    if let Some(pid) = pid.filter(|&p| pid_is_live_qemu(p)) {
        let clean = qmp_powerdown(&dir.join("qmp.sock"), qmp_port).is_ok()
            && wait_pid_gone(pid, Duration::from_secs(15));
        #[cfg(unix)]
        if !clean {
            signal_pid(pid, libc::SIGTERM);
            if !wait_pid_gone(pid, Duration::from_secs(5)) {
                signal_pid(pid, libc::SIGKILL);
                wait_pid_gone(pid, Duration::from_secs(2));
            }
        }
        #[cfg(windows)]
        if !clean {
            terminate_pid(pid);
            wait_pid_gone(pid, Duration::from_secs(5));
        }
        #[cfg(not(any(unix, windows)))]
        let _ = clean;
    }
    crate::services::vm_proxy::stop_proxy(project_id);
    teardown_runtime_files(&dir);
}

/// Shut down every VM this process booted (app exit). VM lifetime is the app
/// session, never longer — like the project containers.
pub fn down_all() {
    let ids: Vec<String> = registry().lock().unwrap().keys().cloned().collect();
    for id in ids {
        shutdown(&id);
    }
}

/// Startup sweep: reap QEMUs a previous (crashed) run left behind, by
/// pidfile. A VM's lifetime is its app session, so anything alive at startup
/// is an orphan. Only pids whose process is actually qemu are signalled — a
/// recycled pid must never kill an innocent process.
pub fn sweep_orphans() {
    let root = vm_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || entry.file_name() == "images" || entry.file_name() == "bake" {
            continue;
        }
        let Ok(pid_text) = std::fs::read_to_string(dir.join("qemu.pid")) else {
            teardown_runtime_files(&dir);
            continue;
        };
        let Ok(pid) = pid_text.trim().parse::<u32>() else {
            teardown_runtime_files(&dir);
            continue;
        };
        if pid_alive(pid) && process_is_qemu(pid) {
            #[cfg(unix)]
            {
                signal_pid(pid, libc::SIGTERM);
                if !wait_pid_gone(pid, Duration::from_secs(5)) {
                    signal_pid(pid, libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            terminate_pid(pid);
        }
        teardown_runtime_files(&dir);
    }
}

/// Whether `pid` is a QEMU process: `/proc/<pid>/comm` on Linux; elsewhere the
/// program name from the process's command line (`KERN_PROCARGS2` on macOS,
/// the image path on Windows), whose basename starts with `qemu`.
fn process_is_qemu(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .map(|comm| comm.trim().starts_with("qemu"))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        crate::sysstat::cmdline(pid)
            .and_then(|cmd| cmd.split_whitespace().next().map(str::to_string))
            .map(|program| {
                let base = program.rsplit(['/', '\\']).next().unwrap_or(&program);
                base.starts_with("qemu")
            })
            .unwrap_or(false)
    }
}

// ── Rebuild / delete ───────────────────────────────────────────────────────

/// Recreate the VM's disk from the base image: delete the overlay (and the
/// seed, so cloud-init re-provisions). Refused while the VM runs. In-VM
/// uncommitted work dies with the overlay — the caller owns the confirm.
pub fn rebuild(project_id: &str) -> Result<(), String> {
    if is_running(project_id) {
        return Err("Shut the VM down before rebuilding it.".to_string());
    }
    let dir = vm_dir(project_id);
    for name in ["disk.qcow2", "seed.iso"] {
        let path = dir.join(name);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("remove {name}: {e}"))?;
        }
    }
    let _ = std::fs::remove_dir_all(dir.join("seed"));
    Ok(())
}

/// Tear down and delete every trace of the project's VM (project delete).
/// The overlay **is** the working tree for a mirrorless VM project — the
/// caller's confirm dialog must have said so by name.
pub fn delete_state(project_id: &str) {
    shutdown(project_id);
    let _ = std::fs::remove_dir_all(vm_dir(project_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── doctor_verdict ─────────────────────────────────────────────────────

    fn good_probes() -> VmDoctorProbes {
        VmDoctorProbes {
            supported: true,
            qemu: true,
            kvm: true,
            kvm_reason: None,
            qemu_img: true,
            iso_tool: Some("genisoimage".to_string()),
            disk_free_gb: Some(100),
            base_image_ready: true,
            baked_image_ready: false,
            firmware_ok: true,
        }
    }

    #[test]
    fn doctor_ok_when_all_probes_pass() {
        let report = doctor_verdict(&good_probes());
        assert!(report.ok);
        assert!(report.reasons.is_empty());
    }

    #[test]
    fn doctor_missing_base_image_is_not_a_failure() {
        // A missing base image is a one-click fetch, not an unavailable tier.
        let probes = VmDoctorProbes {
            base_image_ready: false,
            ..good_probes()
        };
        let report = doctor_verdict(&probes);
        assert!(report.ok);
        assert!(!report.base_image_ready);
    }

    #[test]
    fn doctor_unsupported_platform_fails_with_one_reason() {
        let probes = VmDoctorProbes {
            supported: false,
            ..Default::default()
        };
        let report = doctor_verdict(&probes);
        assert!(!report.ok);
        assert_eq!(report.reasons.len(), 1);
    }

    #[test]
    fn doctor_names_each_missing_piece() {
        let probes = VmDoctorProbes {
            qemu: false,
            kvm: false,
            kvm_reason: Some("kvm group".to_string()),
            iso_tool: None,
            ..good_probes()
        };
        let report = doctor_verdict(&probes);
        assert!(!report.ok);
        assert!(report
            .reasons
            .iter()
            .any(|r| r.contains(GuestArch::host().qemu_binary())));
        assert!(report.reasons.iter().any(|r| r == "kvm group"));
        assert!(report.reasons.iter().any(|r| r.contains("genisoimage")));
    }

    #[test]
    fn install_command_names_only_the_missing_packages() {
        // apt line for a host missing qemu-img alone.
        let probes = VmDoctorProbes {
            qemu_img: false,
            ..good_probes()
        };
        assert_eq!(
            install_command_for(HostOs::Linux, GuestArch::X86_64, &probes).as_deref(),
            Some("sudo apt-get install -y qemu-utils")
        );
        // …and every piece at once, arm64's firmware included.
        let probes = VmDoctorProbes {
            qemu: false,
            qemu_img: false,
            firmware_ok: false,
            iso_tool: None,
            ..good_probes()
        };
        assert_eq!(
            install_command_for(HostOs::Linux, GuestArch::Aarch64, &probes).as_deref(),
            Some("sudo apt-get install -y qemu-system-arm qemu-utils qemu-efi-aarch64 genisoimage")
        );
        assert_eq!(
            install_command_for(HostOs::Macos, GuestArch::Aarch64, &probes).as_deref(),
            Some("brew install qemu xorriso")
        );
        assert!(install_command_for(HostOs::Windows, GuestArch::X86_64, &probes)
            .is_some_and(|c| c.contains("winget install")));
    }

    #[test]
    fn install_command_absent_when_nothing_is_installable() {
        // Everything present: no button.
        assert!(install_command_for(HostOs::Linux, GuestArch::X86_64, &good_probes()).is_none());
        // A kvm permission problem is a sentence to read, not a package.
        let probes = VmDoctorProbes {
            kvm: false,
            kvm_reason: Some("not in the kvm group".to_string()),
            ..good_probes()
        };
        assert!(install_command_for(HostOs::Linux, GuestArch::X86_64, &probes).is_none());
        // An unsupported host has nothing to install either.
        let probes = VmDoctorProbes {
            supported: false,
            ..Default::default()
        };
        assert!(install_command_for(HostOs::Linux, GuestArch::X86_64, &probes).is_none());
    }

    #[test]
    fn doctor_warns_on_low_disk() {
        let probes = VmDoctorProbes {
            disk_free_gb: Some(3),
            ..good_probes()
        };
        let report = doctor_verdict(&probes);
        // Low disk warns but doesn't gate: the overlay may stay small.
        assert!(report.ok);
        assert!(report.reasons.iter().any(|r| r.contains("disk space")));
    }

    // ── host hypervisor argv ─────────────────────────────────────────────

    #[test]
    fn machine_args_follow_the_hosts_hypervisor() {
        let linux = machine_args_for(HostOs::Linux, GuestArch::X86_64, None).unwrap();
        assert_eq!(linux, ["-enable-kvm", "-machine", "q35", "-cpu", "host"]);
        let mac = machine_args_for(HostOs::Macos, GuestArch::X86_64, None).unwrap();
        assert_eq!(mac, ["-accel", "hvf", "-machine", "q35", "-cpu", "host"]);
        let win = machine_args_for(HostOs::Windows, GuestArch::X86_64, None).unwrap();
        assert_eq!(win, ["-accel", "whpx", "-machine", "q35", "-cpu", "max"]);
        let fw = Path::new("/opt/homebrew/share/qemu/edk2-aarch64-code.fd");
        let apple = machine_args_for(HostOs::Macos, GuestArch::Aarch64, Some(fw)).unwrap();
        assert_eq!(
            apple,
            [
                "-accel",
                "hvf",
                "-machine",
                "virt,highmem=on",
                "-cpu",
                "host",
                "-bios",
                "/opt/homebrew/share/qemu/edk2-aarch64-code.fd"
            ]
        );
        assert!(machine_args_for(HostOs::Windows, GuestArch::Aarch64, None).is_none());
        assert_eq!(GuestArch::Aarch64.qemu_binary(), "qemu-system-aarch64");
        assert!(GuestArch::Aarch64.stock_image_name().contains("arm64"));
        assert_eq!(GuestArch::X86_64.baked_image_name(), format!("{}{BASE_VERSION}.qcow2", crate::brand::VM_BASE_IMAGE_PREFIX));
    }

    #[test]
    fn qmp_endpoint_is_a_socket_on_unix_and_a_port_on_windows() {
        assert_eq!(
            qmp_endpoint(Path::new("/state/vm/p1/qmp.sock"), None),
            "unix:/state/vm/p1/qmp.sock,server=on,wait=off"
        );
        assert_eq!(
            qmp_endpoint(Path::new("ignored"), Some(4444)),
            "tcp:127.0.0.1:4444,server=on,wait=off"
        );
    }

    #[test]
    fn doctor_reports_missing_firmware_only_where_it_matters() {
        let probes = VmDoctorProbes {
            firmware_ok: false,
            ..good_probes()
        };
        let report = doctor_verdict(&probes);
        assert!(!report.ok);
        assert!(report.reasons.iter().any(|r| r.contains("edk2-aarch64-code.fd")));
    }

    // ── netdev / qemu argv ─────────────────────────────────────────────────

    #[test]
    fn netdev_open_is_plain_nat_with_ssh_forward() {
        let arg = netdev_arg(VmEgress::Open, 40022, None, None);
        assert_eq!(arg, "user,id=net0,hostfwd=tcp:127.0.0.1:40022-:22");
    }

    #[test]
    fn netdev_off_restricts_and_keeps_the_ssh_forward() {
        let arg = netdev_arg(VmEgress::Off, 40022, None, None);
        assert!(arg.contains("restrict=on"), "{arg}");
        assert!(arg.contains("hostfwd=tcp:127.0.0.1:40022-:22"), "{arg}");
        assert!(!arg.contains("guestfwd"), "{arg}");
    }

    #[test]
    fn netdev_proxy_restricts_and_wires_the_guestfwd() {
        let arg = netdev_arg(VmEgress::Proxy, 40022, Some(41000), None);
        assert!(arg.contains("restrict=on"), "{arg}");
        assert!(
            arg.contains("guestfwd=tcp:10.0.2.100:3128-tcp:127.0.0.1:41000"), // privacy-check: ok — QEMU slirp, not a real host
            "{arg}"
        );
    }

    /// Only a flagged reader gets the second channel, and only under Proxy.
    #[test]
    fn netdev_reader_adds_the_mcp_guestfwd_beside_the_proxys() {
        let arg = netdev_arg(VmEgress::Proxy, 40022, Some(41000), Some(42000));
        assert!(arg.contains("restrict=on"), "{arg}");
        assert!(arg.contains(":3128-tcp:127.0.0.1:41000"), "{arg}");
        assert!(arg.contains(":8765-tcp:127.0.0.1:42000"), "{arg}");
        for egress in [VmEgress::Open, VmEgress::Off] {
            let arg = netdev_arg(egress, 40022, None, Some(42000));
            assert!(!arg.contains("42000"), "{arg}");
        }
    }

    #[test]
    fn qemu_args_shape() {
        let machine = machine_args_for(HostOs::Linux, GuestArch::X86_64, None).unwrap();
        let args = qemu_args(
            &machine,
            4096,
            2,
            Path::new("/state/vm/p1/disk.qcow2"),
            Path::new("/state/vm/p1/seed.iso"),
            "user,id=net0",
            Path::new("/state/vm/p1/qemu.pid"),
            &qmp_endpoint(Path::new("/state/vm/p1/qmp.sock"), None),
            Path::new("/state/vm/p1/serial.log"),
            true,
        );
        let joined = args.join(" ");
        assert!(joined.starts_with("-enable-kvm -machine q35 -cpu host"));
        // Windows: no -daemonize, QMP over loopback TCP.
        let win = qemu_args(
            &machine_args_for(HostOs::Windows, GuestArch::X86_64, None).unwrap(),
            4096,
            2,
            Path::new(r"C:\\state\\vm\\p1\\disk.qcow2"),
            Path::new(r"C:\\state\\vm\\p1\\seed.iso"),
            "user,id=net0",
            Path::new(r"C:\\state\\vm\\p1\\qemu.pid"),
            &qmp_endpoint(Path::new("ignored"), Some(4444)),
            Path::new(r"C:\\state\\vm\\p1\\serial.log"),
            false,
        );
        assert!(!win.contains(&"-daemonize".to_string()));
        assert!(win.join(" ").contains("-qmp tcp:127.0.0.1:4444,server=on,wait=off"));
        assert!(joined.contains("-m 4096"));
        assert!(joined.contains("-smp 2"));
        assert!(joined.contains("file=/state/vm/p1/disk.qcow2,if=virtio,format=qcow2"));
        assert!(joined.contains("-daemonize"));
        assert!(joined.contains("unix:/state/vm/p1/qmp.sock,server=on,wait=off"));
        // The seed must be attached read-only — it's consumed, never written.
        assert!(joined.contains("media=cdrom,format=raw,readonly=on"));
    }

    // ── cloud-init ─────────────────────────────────────────────────────────

    #[test]
    fn user_data_carries_user_key_and_project_dir() {
        let doc = cloud_init_user_data("vm-proj", "ssh-ed25519 AAAA test", false);
        assert!(doc.starts_with("#cloud-config\n"));
        assert!(doc.contains(concat!("name: ", crate::app_slug!())));
        assert!(doc.contains("ssh-ed25519 AAAA test"));
        assert!(doc.contains(concat!("mkdir -p /home/", crate::app_slug!(), "/project")));
        assert!(doc.contains("ssh_pwauth: false"));
        assert!(!doc.contains("http_proxy"));
    }

    #[test]
    fn user_data_proxy_mode_sets_the_guest_proxy_env() {
        let doc = cloud_init_user_data("vm-proj", "ssh-ed25519 AAAA test", true);
        assert!(doc.contains("export https_proxy=http://10.0.2.100:3128")); // privacy-check: ok — QEMU slirp, not a real host
        assert!(doc.contains(concat!("/etc/apt/apt.conf.d/95", crate::app_slug!(), "-proxy")));
        assert!(doc.contains("/etc/environment"));
    }

    #[test]
    fn seed_instance_id_moves_with_the_config() {
        let a = seed_instance_id("project-1234", "#cloud-config\na");
        let b = seed_instance_id("project-1234", "#cloud-config\nb");
        assert_ne!(a, b);
        assert!(a.starts_with(concat!(crate::app_slug!(), "-project-")));
        // …and is stable for a stable config:
        assert_eq!(a, seed_instance_id("project-1234", "#cloud-config\na"));
    }

    /// The rule of [`VmNames`]: after a rename, a VM an older build created
    /// is seeded byte-for-byte as that build seeded it — same user-data, same
    /// instance id, same hostname — so cloud-init does not run first boot
    /// again. Only a VM created under the current name gets the current ones.
    #[test]
    fn an_existing_vm_keeps_its_seed_across_a_rename() {
        use crate::brand::{Forms, Pair, LEGACY};
        let renamed = Pair {
            cur: Forms { display: "Newname", slug: "newname", upper: "NEWNAME" },
            legacy: LEGACY,
        };
        let key = "ssh-ed25519 AAAA test";
        // What the older build wrote at every boot of this VM.
        let old_names = VmNames::of(&LEGACY);
        for proxy in [false, true] {
            let was_data = cloud_init_user_data_for(&old_names, "vm-proj", key, proxy);
            let was_id = seed_instance_id_for(&old_names, "project-1234", &was_data);

            // The renamed build, for the same VM: its record stores the old user.
            let names = VmNames::of_existing(&renamed, Some(LEGACY.name(crate::brand::Name::VM_USER).as_str()));
            assert_eq!(names, old_names);
            let data = cloud_init_user_data_for(&names, "vm-proj", key, proxy);
            assert_eq!(data, was_data, "user-data moved (proxy: {proxy})");
            assert_eq!(seed_instance_id_for(&names, "project-1234", &data), was_id);
            assert_eq!(vm_hostname_for(&names, "---"), vm_hostname_for(&old_names, "---"));

            // A VM the renamed build creates stores the current user.
            let fresh = VmNames::of_existing(&renamed, Some("newname"));
            let fresh_data = cloud_init_user_data_for(&fresh, "vm-proj", key, proxy);
            assert!(fresh_data.contains("  - name: newname\n"));
            assert!(fresh_data.contains("mkdir -p /home/newname/project"));
            assert!(!fresh_data.contains(LEGACY.slug));
            assert!(seed_instance_id_for(&fresh, "project-1234", &fresh_data).starts_with("newname-project-"));
            assert_ne!(seed_instance_id_for(&fresh, "project-1234", &fresh_data), was_id);
        }
        // No record, or a user that is neither: the current names.
        assert_eq!(VmNames::of_existing(&renamed, None), VmNames::of(&renamed.cur));
        // The production pair: the constants, whichever way it is asked.
        let production = VmNames::of_existing(&crate::brand::PAIR, Some(VM_USER));
        assert_eq!(production.user, VM_USER);
        assert_eq!(production.project_dir, VM_PROJECT_DIR);
        assert_eq!(
            cloud_init_user_data_for(&production, "vm-proj", key, true),
            cloud_init_user_data("vm-proj", key, true)
        );
    }

    /// A base image an older build baked is found under its old name and is
    /// never renamed — existing overlays back onto that very file. A new
    /// bake writes the current name, which then wins.
    #[test]
    fn the_baked_image_is_found_under_its_old_name() {
        use crate::brand::{Forms, Pair, LEGACY};
        use crate::services::brand_migration::hits;
        let renamed = Pair {
            cur: Forms { display: "Newname", slug: "newname", upper: "NEWNAME" },
            legacy: LEGACY,
        };
        let images = tempfile::tempdir().expect("tempdir");
        let arch = GuestArch::host();
        let old = images.path().join(arch.baked_image_name_for(&LEGACY));
        let new = images.path().join(arch.baked_image_name_for(&renamed.cur));
        let _ = hits::taken();
        assert_eq!(baked_image_path_in(&renamed, images.path()), new);
        assert!(hits::taken().is_empty());
        std::fs::write(&old, b"qcow").expect("write");
        assert_eq!(baked_image_path_in(&renamed, images.path()), old);
        assert_eq!(hits::taken(), ["vm-base-image"]);
        std::fs::write(&new, b"qcow").expect("write");
        assert_eq!(baked_image_path_in(&renamed, images.path()), new);
        assert!(old.is_file(), "the old image stays for the overlays that back onto it");
    }

    #[test]
    fn hostname_is_guest_safe() {
        assert_eq!(vm_hostname("My Project!"), "vm-my-project");
        assert_eq!(vm_hostname("---"), concat!(crate::app_slug!(), "-vm"));
        assert!(vm_hostname(&"x".repeat(100)).len() <= 27);
    }

    // ── seed iso argv ──────────────────────────────────────────────────────

    #[test]
    fn seed_iso_args_per_tool() {
        assert_eq!(seed_iso_args("genisoimage")[0], "-output");
        assert_eq!(seed_iso_args("xorriso")[..2], ["-as", "mkisofs"]);
        assert_eq!(
            seed_iso_args("cloud-localds"),
            ["seed.iso", "user-data", "meta-data"]
        );
    }

    // ── vm_ssh_opts ────────────────────────────────────────────────────────

    #[test]
    fn ssh_opts_only_for_registered_loopback_ports() {
        // Nothing registered → no opts, whoever asks.
        assert!(vm_ssh_opts("127.0.0.1", Some(45999)).is_empty());
        registry().lock().unwrap().insert(
            "test-ssh-opts".to_string(),
            RunningVm {
                dir: PathBuf::from("/state/vm/test-ssh-opts"),
                runtime: VmRuntime {
                    pid: u32::MAX, // never alive, but opts don't require liveness
                    ssh_port: 45998,
                    proxy_port: None,
                    qmp_port: None,
                    egress: VmEgress::Proxy,
                    base_image: String::new(),
                },
            },
        );
        let opts = vm_ssh_opts("127.0.0.1", Some(45998));
        assert!(opts
            .iter()
            .any(|o| o == "/state/vm/test-ssh-opts/known_hosts" || o.ends_with("known_hosts")));
        assert!(opts.iter().any(|o| o == "IdentitiesOnly=yes"));
        // A real (non-loopback) host on the same port must never match.
        assert!(vm_ssh_opts("build.example.com", Some(45998)).is_empty());
        registry().lock().unwrap().remove("test-ssh-opts");
    }
}
