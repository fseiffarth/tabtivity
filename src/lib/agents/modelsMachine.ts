import { invoke } from "@tauri-apps/api/core";
import type { GpuSample } from "../gpu";
import { isServerClient } from "../transport/linkState";

/**
 * The machine's CPU + memory load (backend `MachineLoadSample`). The GPU half of
 * the same question comes from `gpu_memory_snapshot`; these two are separate
 * commands because the GPU read is cached and instant while this one spans a
 * 300 ms sampling window (a CPU percentage is a ratio of two readings).
 */
export interface MachineLoad {
  supported: boolean;
  cpu_percent: number;
  num_cores: number;
  load_avg: [number, number, number];
  mem_total_bytes: number;
  mem_used_bytes: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  cpu_temp_c: number | null;
  /** Hottest DIMM, where the board wires an on-module sensor (`jc42`/`spd5118`).
      `null` — the usual answer — is "no sensor", never a cold reading. */
  mem_temp_c?: number | null;
}

/**
 * One reading of the machine the local models run on: its GPUs and its CPU +
 * RAM, for the Models & agents meters and the intro's model recommendation.
 * In the window that is this machine (`gpu_memory_snapshot`,
 * `machine_load_snapshot`); in the browser client it is the server, where the
 * shared Ollama runs, and those two readings are the client's (`client`
 * class), so the server answers both in one call (`models_host_load`).
 */
export function readModelsMachine(): { gpus: Promise<GpuSample[]>; machine: Promise<MachineLoad> } {
  if (isServerClient()) {
    const both = invoke<{ machine: MachineLoad; gpus: GpuSample[] }>("models_host_load");
    return { gpus: both.then((b) => b.gpus), machine: both.then((b) => b.machine) };
  }
  return { gpus: invoke<GpuSample[]>("gpu_memory_snapshot"), machine: invoke<MachineLoad>("machine_load_snapshot") };
}
