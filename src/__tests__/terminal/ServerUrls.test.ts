import { describe, expect, it } from "vitest";
import type { LineLike } from "../../lib/terminal/terminalSelection";
import { findServerUrls, forwardedUrl, localPageUrl, parseServerTarget } from "../../lib/terminal/serverUrls";

const COLS = 100;

function row(text: string, isWrapped = false): LineLike {
  const cells = text.padEnd(COLS, " ").slice(0, COLS);
  return {
    isWrapped,
    getCell: (x) => (x < COLS ? { getChars: () => cells[x], getWidth: () => 1 } : undefined),
    translateToString: (trimRight, start = 0, end = COLS) => {
      const s = cells.slice(start, end);
      return trimRight ? s.replace(/\s+$/u, "") : s;
    },
  };
}

function scan(lines: string[], cols = COLS) {
  const rows = lines.map((l) => row(l));
  return findServerUrls((y) => rows[y], cols, 0, rows.length - 1);
}

describe("findServerUrls: the kinds", () => {
  it("reads JupyterLab's two printed URLs as one server, token kept in the path", () => {
    const servers = scan([
      "[I 2026-11-05 10:00:00.000 ServerApp] Jupyter Server 2.14.2 is running at:",
      "[I 2026-11-05 10:00:00.000 ServerApp] http://node042:8888/lab?token=abc123",
      "[I 2026-11-05 10:00:00.000 ServerApp]     http://127.0.0.1:8888/lab?token=abc123",
    ]);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ kind: "jupyter", host: "127.0.0.1", port: 8888, pathAndQuery: "/lab?token=abc123" });
  });

  it("reads TensorBoard from its own line", () => {
    const [s] = scan(["TensorBoard 2.17.0 at http://localhost:6006/ (Press CTRL+C to quit)"]);
    expect(s).toMatchObject({ kind: "tensorboard", host: "localhost", port: 6006, pathAndQuery: "/" });
  });

  it("reads Vite by 'Local:' with VITE above", () => {
    const [s] = scan(["  VITE v5.4.0  ready in 312 ms", "", "  ➜  Local:   http://localhost:5173/", "  ➜  Network: use --host to expose"]);
    expect(s).toMatchObject({ kind: "vite", port: 5173 });
  });

  it("reads Streamlit and Gradio", () => {
    expect(scan(["  Local URL: http://localhost:8501", "  Network URL: http://192.0.2.20:8501"])).toMatchObject([
      { kind: "streamlit", port: 8501 },
    ]);
    expect(scan(["* Running on local URL:  http://127.0.0.1:7860"])).toMatchObject([{ kind: "gradio", port: 7860 }]);
  });

  it("calls anything else a generic server (Flask, http.server)", () => {
    expect(scan(["Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ..."])).toMatchObject([
      { kind: "generic", host: "127.0.0.1", port: 8000 },
    ]);
    expect(scan([" * Running on http://127.0.0.1:5000"])).toMatchObject([{ kind: "generic", port: 5000 }]);
  });
});

describe("findServerUrls: what it leaves out", () => {
  it("rewrites 0.0.0.0 and :: to the loopback", () => {
    expect(scan(["listening on http://0.0.0.0:3000"])[0].host).toBe("127.0.0.1");
    expect(scan(["listening on http://[::]:3000/"])[0].host).toBe("127.0.0.1");
    expect(scan(["listening on http://[::1]:3000/"])[0].host).toBe("::1");
  });

  it("never turns an OAuth localhost callback into a server", () => {
    // The CLI's sign-in link carries its localhost callback encoded in redirect_uri.
    expect(
      scan([
        "Open this URL to sign in:",
        "https://accounts.example.com/o/oauth2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcb",
      ]),
    ).toEqual([]);
    // A sign-in page served on localhost itself is a sign-in link, not a server.
    expect(scan(["http://localhost:4000/login/device?x=1"])).toEqual([]);
    expect(scan(["http://localhost:4000/cb?response_type=code&client_id=a"])).toEqual([]);
    expect(scan(["http://localhost:4000/cb?code_challenge=abc"])).toEqual([]);
    expect(scan(["http://localhost:1455/auth?client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcb"])).toEqual([]);
  });

  it("ignores a URL without a port and a dotted public host", () => {
    expect(scan(["see http://localhost/docs and http://localhost for more"])).toEqual([]);
    expect(scan(["Local URL: http://intranet/"])).toEqual([]);
    expect(scan(["docs at https://example.com:8443/guide and http://192.0.2.5:8000/"])).toEqual([]);
    expect(scan(["https://github.com/org/repo"])).toEqual([]);
  });

  it("keeps only the newest URL per port and the newest last", () => {
    const servers = scan([
      "Local: http://localhost:5173/old",
      "TensorBoard 2.x at http://localhost:6006/",
      "Local: http://localhost:5173/new",
    ]);
    expect(servers.map((s) => [s.port, s.pathAndQuery])).toEqual([
      [6006, "/"],
      [5173, "/new"],
    ]);
  });

  it("drops a server whose program has stopped (a stop message or a shell prompt below)", () => {
    expect(scan(["Local: http://localhost:5173/", "^C", "user@box:~/proj$"])).toEqual([]);
    expect(scan(["Local: http://localhost:5173/", "user@box:~/proj$"])).toEqual([]);
    expect(scan(["Jupyter at http://localhost:8888/lab", "Shutting down 1 kernel"])).toEqual([]);
    // A newer URL below the prompt is a new run.
    expect(scan(["Local: http://localhost:5173/", "$", "Local: http://localhost:5173/"])).toHaveLength(1);
    // Ordinary log lines keep it.
    expect(scan(["Local: http://localhost:5173/", "10:00:01 [vite] hmr update /src/App.tsx"])).toHaveLength(1);
  });

  it("follows a URL wrapped across rows", () => {
    const cols = 40;
    const url = "http://localhost:8888/lab?token=" + "a".repeat(30);
    const lines = [url.slice(0, cols), url.slice(cols)];
    const rows = lines.map((text) => {
      const r = row(text);
      return r;
    });
    const servers = findServerUrls((y) => rows[y], COLS, 0, 1);
    // Hard-wrapped rows are only joined when the next row is a bare URL piece.
    expect(servers.length).toBeGreaterThanOrEqual(1);
    expect(servers[0].port).toBe(8888);
  });
});

describe("parseServerTarget and the URLs built from it", () => {
  it("takes loopback hosts with or without a port, bare names only with one", () => {
    expect(parseServerTarget("http://localhost/x")).toMatchObject({ host: "localhost", port: 80, pathAndQuery: "/x" });
    expect(parseServerTarget("https://127.0.0.1/")).toMatchObject({ port: 443, scheme: "https" });
    expect(parseServerTarget("http://localhost/x", true)).toBeNull();
    expect(parseServerTarget("http://node042:8888/")).toMatchObject({ host: "node042", port: 8888 });
    expect(parseServerTarget("http://node042/")).toBeNull();
    expect(parseServerTarget("http://example.com:8888/")).toBeNull();
    expect(parseServerTarget("http://user:pw@localhost:1/")).toBeNull();
    expect(parseServerTarget("ftp://localhost:21/")).toBeNull();
    expect(parseServerTarget("not a url")).toBeNull();
  });

  it("opens a forwarded page on 127.0.0.1, never localhost, keeping path and token", () => {
    const t = parseServerTarget("http://localhost:8888/lab?token=abc#x")!;
    expect(forwardedUrl(t, 9001)).toBe("http://127.0.0.1:9001/lab?token=abc#x");
    expect(localPageUrl(parseServerTarget("http://0.0.0.0:3000/")!)).toBe("http://127.0.0.1:3000/");
    expect(localPageUrl(parseServerTarget("http://[::1]:3000/")!)).toBe("http://[::1]:3000/");
  });
});
