# Performance numbers

Appended by `scripts/perf-numbers.sh` (see `docs/performance_plan.md` §1).
Each section is one run; the label says which build state it measured.

## before-merge-pdfs-closed — 2026-10-11T07:36:41Z (window 30s)

- app pid 3361679 (tabtivity-dev), renderer pid 3361956
- renderer memory: VmRSS: 1115280 kB  VmSwap: 0 kB
- app memory: VmRSS: 671064 kB  VmSwap: 0 kB
- load: 0.70 0.48 0.73 on 24 cores
- memory snapshot only

## before-merge — 2026-10-11T07:56:44Z (window 30s)

- app pid 3361679 (tabtivity-dev), renderer pid 3361956
- renderer memory: VmRSS: 926528 kB  VmSwap: 0 kB
- app memory: VmRSS: 691788 kB  VmSwap: 0 kB
- load: 0.57 1.78 3.21 on 24 cores

### 1. Renderer (pid 3361956)

- whole process: 7.5 % of one core; schedstat run 1811 ms, runqueue wait 4 ms over 30 s
- busiest threads (tid, nice, % of one core, name):
  - 3361956 ni=-10 6.0% WebKitWebProces
  - 3361962 ni=0 0.3% WebKitWebProces
  - 3587876 ni=0 0.0% s Signal Sender
  - 3362196 ni=0 0.0% DataURLDecoder
  - 3362143 ni=0 0.0% CryptoQueue
- rtkit: active

### 2. App process (pid 3361679)

- whole process: 1.9 % of one core; main thread: 0.9 %
- voluntary context switches: 21 /s (243352 → 243997)
- threads: 153
- busiest descendants (pid, % of one core, name):
  - 3361956 7.5% WebKitWebProces
  - 3363058 1.0% claude
  - 3363109 0.7% claude
  - 3363104 0.7% claude
  - 3364509 0.6% claude
  - 3363127 0.6% claude
  - 3363091 0.6% claude
  - 3363072 0.6% claude

### 3. Memory

- renderer: VmRSS: 941816 kB  VmSwap: 0 kB
- app: VmRSS: 691972 kB  VmSwap: 0 kB
- (run `scripts/perf-numbers.sh --rss before-merge-pdfs-closed` 20 s after closing the PDF tabs for the second half)

### 4. Stopwatch (fill in by hand)

- switch to a streaming agent tab → first paint: ___ s
- switch to a 100-page PDF tab → pages painted: ___ s

## after-merge — 2026-10-11T08:09:30Z (window 30s)

- app pid 3773290 (tabtivity-dev), renderer pid 3774419
- renderer memory: VmRSS: 538828 kB  VmSwap: 0 kB
- app memory: VmRSS: 298308 kB  VmSwap: 0 kB
- load: 8.60 6.59 5.75 on 24 cores

### 1. Renderer (pid 3774419)

- whole process: 3.6 % of one core; schedstat run 894 ms, runqueue wait 0 ms over 30 s
- busiest threads (tid, nice, % of one core, name):
  - 3774419 ni=-10 3.0% WebKitWebProces
  - 3786265 ni=0 0.1% JITWorker
  - 3774424 ni=0 0.1% WebKitWebProces
  - 3775415 ni=0 0.0% DataURLDecoder
  - 3774939 ni=0 0.0% CryptoQueue
- rtkit: active

### 2. App process (pid 3773290)

- whole process: 0.8 % of one core; main thread: 0.2 %
- voluntary context switches: 3 /s (4611 → 4716)
- threads: 149
- busiest descendants (pid, % of one core, name):
  - 3774419 3.6% WebKitWebProces
  - 3776050 0.8% claude
  - 3776021 0.8% claude
  - 3776009 0.8% claude
  - 3775998 0.8% claude
  - 3775983 0.8% claude
  - 3775966 0.8% claude
  - 3776783 0.7% claude

### 3. Memory

- renderer: VmRSS: 489748 kB  VmSwap: 0 kB
- app: VmRSS: 327500 kB  VmSwap: 0 kB
- (run `scripts/perf-numbers.sh --rss after-merge-pdfs-closed` 20 s after closing the PDF tabs for the second half)

### 4. Stopwatch (fill in by hand)

- switch to a streaming agent tab → first paint: ___ s
- switch to a 100-page PDF tab → pages painted: ___ s

## after-merge-pdfs-closed — 2026-10-11T08:10:23Z (window 30s)

- app pid 3773290 (tabtivity-dev), renderer pid 3774419
- renderer memory: VmRSS: 477340 kB  VmSwap: 0 kB
- app memory: VmRSS: 327568 kB  VmSwap: 0 kB
- load: 3.57 5.51 5.43 on 24 cores
- memory snapshot only
