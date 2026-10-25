import { describe, it, expect } from "vitest";
import { argsFromLines, argsToLines } from "../../lib/terminal/runArgsFormat";

describe("run args list form", () => {
  it("puts each option on its own line with its values", () => {
    expect(
      argsToLines("--config a/main_round1.yml --config a/main_round2.yml --num_threads 4"),
    ).toBe("--config a/main_round1.yml\n--config a/main_round2.yml\n--num_threads 4");
  });

  it("keeps leading positionals together and negative numbers as values", () => {
    expect(argsToLines("data.csv out/ -v --lr -0.5 -")).toBe("data.csv out/\n-v\n--lr -0.5 -");
  });

  it("never splits inside quotes or escapes", () => {
    expect(argsToLines(`--name "a --b c" --x 'y z' --p a\\ --q`)).toBe(
      `--name "a --b c"\n--x 'y z'\n--p a\\ --q`,
    );
  });

  it("joins the list back into one command-line fragment", () => {
    expect(argsFromLines("--config a.yml\n  --num_threads 4 \n\n--v")).toBe(
      "--config a.yml --num_threads 4 --v",
    );
    expect(argsFromLines("--a 1 \\\n--b 2\r\n--c")).toBe("--a 1 --b 2 --c");
  });

  it("keeps a quoted line break", () => {
    expect(argsFromLines(`--msg "one\ntwo"\n--x`)).toBe(`--msg "one\ntwo" --x`);
  });

  it("round-trips", () => {
    const s = `in.txt --config "my dir/c.yml" --threads 4 -v`;
    expect(argsFromLines(argsToLines(s))).toBe(s);
  });
});
