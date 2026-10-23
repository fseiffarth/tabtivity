# Desktop voice, step 0: runtime probes (host only)

Probes for `docs/desktop_voice_plan.md`, step 0. Run them on the host, in
your normal desktop session, **outside the fence**, with Tabtivity left as it
is. Neither touches the repo. Copy this folder somewhere outside the repo
first: `cp -r scripts/voice-probe ~/voice-probe`. Delete the folder once the
results are recorded in the plan.

## 1. `spd-say --wait -e`: when does it return?

```sh
cd ~/voice-probe
./spd_wait_probe.sh            # add `-o espeak-ng` to force the module
```

It needs `spd-say`, `parec` (`pulseaudio-utils`; it talks to pipewire-pulse)
and `python3`. Turn off music and videos while it runs. It takes about 30 s and
speaks seven short German/English lines, two of them starting with `-`. Then it
starts one long sentence and kills that `spd-say` after 1 s. At the end it
runs `spd-say -C`, which cancels **every** program's speech-dispatcher
speech: pause a screen reader (Orca) first, or restart it afterwards.

**Send back:** the whole output, especially
- the `RESULT tail_ms: median …, max …` line. This is the time from
  `spd-say` exiting to the sink going silent. A positive value means it
  returned while audio was still playing, so the mute gate's tail has to be at
  least that long. A negative value is the synth's trailing silence;
- the `kill` line: does the voice keep talking after the child is killed?
- `grep -n '^ *AudioOutputMethod' /etc/speech-dispatcher/speechd.conf ~/.config/speech-dispatcher/speechd.conf`
  (pulse or pipewire backend: they drain differently);
- `spd-say -v | head -1`.

Optionally, check by ear that the two lines starting with `-` were spoken as
text.

## 2. `cpal` capture on PipeWire

Build it outside the repo's target dir. It needs the ALSA dev files, which is
the same package the plan's step 0 asks for:

```sh
sudo apt install libasound2-dev pkg-config        # if not yet installed
cd ~/voice-probe/cpal-capture-probe
cargo run --release -- --list                      # ALSA host, 5 s capture
```

Speak for the first 2–3 s, then stay silent. **Send back** the whole output:
the device and config lines, the dBFS column (speech vs silence), the
`frames received … (x %)` line and the final `RESULT …` line (or
`RESULT FAIL <CLASS>` and its exit code `echo $?`).

Also send back:

```sh
dpkg -l pipewire-alsa libasound2-plugins | tail -n +6
ls /etc/alsa/conf.d/
```

and, while `cargo run --release -- --secs 20` is capturing, in a second terminal:

```sh
pw-dump 2>/dev/null | grep -c '"client.api": "alsa"'   # > 0 means it went through pipewire-alsa
```

Optional comparisons. Run each only if it builds; these hosts are not in the plan:

```sh
cargo run --release --features pulseaudio -- --host pulseaudio   # needs libpulse-dev
cargo run --release --features pipewire  -- --host pipewire      # needs libpipewire-0.3-dev clang
```

Failure classes from the exit code: 10 host unavailable, 11 no input device,
12 permission denied, 13 device busy, 14 unsupported config, 15 other
build/play error, 16 stream errors during capture, 17 fewer than 90 % of the
expected frames.

Delete `~/voice-probe` (including `target/`) afterwards.
