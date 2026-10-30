# Voice on the GPU

Status: implemented on develop's working tree (2026-10-30), never run live with a
GPU. This is step 8's GPU half from `docs/desktop_voice_plan.md`. How it works now:
`docs/context/voice.md`. This file keeps why, and what is still unproven.

## Why

whisper.cpp ran on the CPU only. Measured on the dev laptop (Ryzen AI 9 HX 370,
Radeon 890M, RADV), whisper.cpp 1.8.3 identical to the pinned crate, the app's CPU
flags and settings, an 11 s English clip, median of 5 warm runs, model load excluded:

| Model | CPU | Vulkan | Speedup | First Vulkan run |
|---|---|---|---|---|
| `small` q5_1 | 2830 ms | 366 ms | 7.7× | 1.24 s |
| `large-v3-turbo` q5_0 | 14431 ms | 1115 ms | 12.9× | 1.51 s |

The text was identical on `large-v3-turbo`; on `small` one comma differed. Raw runs:
`tmp/voice-bench/results/` (gitignored). Rerun with `tmp/voice-bench/run-on-host.sh`
from a host terminal; a fenced tab has no `/dev/dri`. Both columns ran with flash
attention on, whisper.cpp's default. The app turns it on for the GPU only.

Ollama (`gemma4:e4b`, 0.57 s warm, 14.4 s cold, no punctuation) was considered as a
mic engine and dropped by the user: Vulkan matches it warm, starts far faster and
needs no second install.

## Fixed decisions

- **All three platforms in one round:** Vulkan on Linux and Windows, Metal on
  macOS. Only Linux has been measured.
- **Own cargo features, not in `default`:** `voice-vulkan` and `voice-metal`.
  Plain `voice` stays CPU, so `cargo test --workspace`, the gates and every clean
  build keep working without `glslc` and skip about 300 shader compile steps.
  Bundles and the dev build opt in.
- **GPU is on by default where built,** with a Settings switch `voice_gpu` and the
  crash guard.
- **The label shows what actually happened,** never what was configured.
- **`small` stays the default model.** Moving to `large-v3-turbo` needs German
  testing first.
- **No Ollama engine, no `Voice` role chip.** `ollama_roles` is untouched.
- **The phone is out of scope:** it uses Web Speech, not this engine.

## What changed from the first plan

- **Features sit on `whisper-rs-sys`, not `whisper-rs`.** `whisper-rs/vulkan` also
  compiles a helper module that needs freshly generated bindings. On this machine
  bindgen fails (libclang without its headers: no `stdbool.h`) and falls back to the
  bundled bindings, so that module does not compile. The app never uses it.
- **Windows ships `vulkan-1.dll` instead of delay-loading it.** ggml's registry calls
  `ggml_backend_vk_reg()` on any use of whisper, CPU loads and the voice detector
  included, so a delay-load failure could not be avoided by staying on the CPU.
  With the loader present and no driver, instance creation throws
  `vk::SystemError`, which `ggml_backend_vk_reg` catches.
- **CI uses LunarG's SDK on Linux too,** pinned by version and SHA-256, so the
  bundle does not depend on Ubuntu 24.04's older `glslc` and headers.
- **A machine without `glslc` still builds, on the CPU, with a warning**
  (`scripts/lib/voice_gpu.sh`), rather than stopping a frozen dev build.
- **`voice_gpu` is a renderer-side setting** passed with `voice_listen_start`, like
  the other `voice_*` settings, so no schema change.
- **`voice_gpu_retry` is a new command,** because a crash has to be forgotten
  deliberately.

## What can still go wrong

Read from the pinned source (`whisper-rs-sys` 0.15.0) unless marked.

- **Never run on a GPU through the app.** The benchmark used `whisper-cli`. In a
  fence the app's own path was exercised with a real model and reported
  `no-gpu`; the GPU branch has not run yet.
- **Crash in-process.** whisper runs inside the app. A driver crash, or a C++
  exception crossing the FFI boundary, takes the window and its live tabs down. The
  guard stops the second crash, not the first, and only covers each session's load
  and first run. Assumed from how C++ exceptions and FFI behave, not reproduced.
- **The off switch does not stop ggml's instance.** It stops whisper using a device,
  but ggml still creates its Vulkan instance on any use of whisper, and that loads
  the installed drivers into the process. A driver that crashes at that point would
  crash with the switch off too.
- **AppImage and the loader.** The `.deb` declares `libvulkan1`. Whether linuxdeploy
  bundles the loader is unverified, and an AppImage on a machine without it would
  not start.
- **Windows and macOS have never run this.** The SDK install, the `--config` path,
  the DLL's place beside the exe and Metal under `universal-apple-darwin` first run
  in CI on push. Metal has no benchmark.
- **Package size.** The Vulkan `whisper-cli` is 58.8 MB against 2.7 MB: about +56 MB
  of embedded shaders. Bundle sizes are unmeasured.
- **Software Vulkan is excluded by ggml, not by a test here.** Its default device
  list drops CPU-type devices.

## Verification

Gates per `AGENTS.md`, plus `npm run backend:stale`. The local gates build none of
the GPU features; CI's bundle jobs prove each compiles on its OS. By hand, with the
real path:

```bash
VOICE_TEST_MODEL=<ggml file> cargo test -p tabtivity --lib --features voice-vulkan \
  -- --ignored --nocapture a_real_load_says_where_it_landed
```

Nobody claims it works until the user has clicked through it in the frozen dev
build, which picks up `voice-vulkan` once this is committed:

1. Turn the mic on in a Chat: the row under the composer says
   `GPU · AMD Radeon 890M Graphics (RADV STRIX1)`.
2. Dictate a German and an English sentence on `small` and `large-v3-turbo`.
3. Turn off Settings → Voice → Use the GPU, restart the mic: it says `CPU`, and the
   tooltip says it was turned off.
4. With an Ollama model busy on the GPU, dictate: slower is fine, failing is not.
5. On Windows and macOS, once there is a machine: the app starts, the label shows a
   GPU, and on Windows it also starts where no GPU driver is installed.
