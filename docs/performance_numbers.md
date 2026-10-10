# Performance numbers

Appended by `scripts/perf-numbers.sh` (see `docs/performance_plan.md` §1).
Each section is one run; the label says which build state it measured.

## before — 2026-10-06T21:04:06Z (window 30s)

- app pid 3133220 (tabtivity-dev), renderer pid 3133357
- renderer memory: VmRSS: 1228672 kB  VmSwap: 0 kB
- app memory: VmRSS: 434268 kB  VmSwap: 0 kB
- load: 71.70 66.69 58.53 on 24 cores
### 1. Renderer (pid 3133357)

- whole process: 53.9 % of one core; schedstat run 14173 ms, runqueue wait 1951 ms over 30 s
- busiest threads (tid, nice, % of one core, name):
  - 3133357 ni=-10 47.3% WebKitWebProces
  - 3133367 ni=0 0.9% ReceiveQueue
  - 3133363 ni=0 0.8% WebKitWebProces
  - 3259447 ni=0 0.7% JITWorker
  - 3385293 ni=0 0.0% JITWorker
- rtkit: active

### 2. App process (pid 3133220)

- whole process: 14.3 % of one core; main thread: 4.5 %
- voluntary context switches: 105 /s (198695 → 201864)
- threads: 151
- busiest descendants (pid, % of one core, name):
  - 3133357 52.4% WebKitWebProces
  - 3135745 5.4% opencode
  - 3135793 4.5% opencode
  - 3136064 1.1% claude
  - 3136051 1.1% claude
  - 3134095 1.1% claude
  - 3134030 1.1% claude
  - 3134047 1.0% claude

### 3. Memory

- renderer: VmRSS: 1241048 kB  VmSwap: 0 kB
- app: VmRSS: 436232 kB  VmSwap: 0 kB
- (run `scripts/perf-numbers.sh --rss before-pdfs-closed` 20 s after closing the PDF tabs for the second half)

### 4. Stopwatch (fill in by hand)

- switch to a streaming agent tab → first paint: ___ s
- switch to a 100-page PDF tab → pages painted: ___ s


## before-pdfs-closed — 2026-10-06T21:06:52Z (window 30s)

- app pid 3133220 (tabtivity-dev), renderer pid 3133357
- renderer memory: VmRSS: 1009544 kB  VmSwap: 0 kB
- app memory: VmRSS: 452336 kB  VmSwap: 0 kB
- load: 95.73 77.24 63.75 on 24 cores
- memory snapshot only
