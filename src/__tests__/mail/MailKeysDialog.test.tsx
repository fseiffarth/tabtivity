import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailAccount, PgpKeyInfo } from "../../types/mail";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MailKeysDialog } from "../../components/mail/MailKeysDialog";

const account = { id: "acct-1", label: "Me", address: "me@example.com" } as MailAccount;

function key(over: Partial<PgpKeyInfo>): PgpKeyInfo {
  return {
    fingerprint: "AB".repeat(20),
    identities: ["Me <me@example.com>"],
    addresses: ["me@example.com"],
    secret: true,
    verified: false,
    accounts: [],
    algorithm: "Curve25519",
    origin: "imported",
    revoked: false,
    expired: false,
    notes: [],
    ...over,
  };
}

function serve(keys: PgpKeyInfo[], extra: Record<string, unknown> = {}) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd in extra) return Promise.resolve(extra[cmd]);
    if (cmd === "mail_pgp_keys") return Promise.resolve(keys);
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

const bindCalls = () => invoke.mock.calls.filter((c) => c[0] === "mail_pgp_bind");

describe("binding an imported private key (gap 91)", () => {
  it("asks first, naming the risk, and binds nothing when the user declines", async () => {
    serve([key({})]);
    render(<MailKeysDialog account={account} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use for this account" }));
    expect(await screen.findByText(/imported, not made here/)).toBeTruthy();
    expect(screen.getByText(/sign as me@example\.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/imported, not made here/)).toBeNull());
    expect(bindCalls()).toHaveLength(0);
  });

  it("sends the acknowledgement only after the confirm, and says the key is still unchecked", async () => {
    serve([key({})], {
      mail_pgp_bind: key({ accounts: ["acct-1"], notes: ["bound-imported-unverified"] }),
    });
    render(<MailKeysDialog account={account} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use for this account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this key" }));
    await waitFor(() => expect(bindCalls()).toHaveLength(1));
    expect(bindCalls()[0][1]).toMatchObject({
      fingerprint: "AB".repeat(20),
      accountId: "acct-1",
      bind: true,
      acknowledgeImported: true,
    });
    expect(await screen.findByText(/still unchecked/)).toBeTruthy();
  });

  it("does not ask for a key generated here", async () => {
    serve([key({ origin: "generated" })]);
    render(<MailKeysDialog account={account} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use for this account" }));
    await waitFor(() => expect(bindCalls()).toHaveLength(1));
    expect(screen.queryByText(/imported, not made here/)).toBeNull();
    expect(bindCalls()[0][1]).toMatchObject({ acknowledgeImported: false });
  });
});

describe("revoked and expired keys (gap 88)", () => {
  it("labels them and does not offer them for an account", async () => {
    serve([
      key({ fingerprint: "11".repeat(20), revoked: true }),
      key({ fingerprint: "22".repeat(20), expired: true }),
    ]);
    render(<MailKeysDialog account={account} onClose={() => {}} />);
    expect(await screen.findByText(/revoked by its owner/)).toBeTruthy();
    expect(screen.getByText(/expired — not used/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use for this account" })).toBeNull();
  });
});

describe("a re-import that reset the trust (gap 76)", () => {
  it("says the tick and the binding are gone", async () => {
    serve([], {
      mail_pgp_import: [
        key({
          secret: false,
          identities: ["Friend <friend@corp.example>"],
          notes: ["identities-changed-unverified"],
        }),
      ],
    });
    render(<MailKeysDialog account={account} onClose={() => {}} />);
    const box = await screen.findByPlaceholderText("-----BEGIN PGP PUBLIC KEY BLOCK-----");
    fireEvent.change(box, { target: { value: "-----BEGIN PGP PUBLIC KEY BLOCK-----" } });
    fireEvent.click(screen.getByRole("button", { name: "Add pasted key" }));
    expect(await screen.findByText(/names different people than the one you checked/)).toBeTruthy();
  });
});
