import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sideChatHolder, useReaderSideChatStore } from "../../stores/agents/readerSideChat";
import { ReaderSideChat } from "../../components/layout/ReaderSideChat";

const claim = (ptyId: string, label = ptyId, showChat = () => {}) => ({ ptyId, label, showChat });

afterEach(() => {
  useReaderSideChatStore.setState({ claims: [], slot: null });
});

describe("readerSideChat store", () => {
  it("gives the panel to the last Reader that wants it, and back when it lets go", () => {
    const s = useReaderSideChatStore.getState();
    s.want(claim("p:a"));
    s.want(claim("p:b"));
    expect(sideChatHolder(useReaderSideChatStore.getState())?.ptyId).toBe("p:b");
    useReaderSideChatStore.getState().drop("p:b");
    expect(sideChatHolder(useReaderSideChatStore.getState())?.ptyId).toBe("p:a");
    useReaderSideChatStore.getState().drop("p:a");
    expect(sideChatHolder(useReaderSideChatStore.getState())).toBeNull();
  });

  it("updates a claim where it stands, and raise makes it the holder", () => {
    const s = useReaderSideChatStore.getState();
    s.want(claim("p:a", "one"));
    s.want(claim("p:b"));
    useReaderSideChatStore.getState().want(claim("p:a", "renamed"));
    let st = useReaderSideChatStore.getState();
    expect(sideChatHolder(st)?.ptyId).toBe("p:b");
    expect(st.claims[0].label).toBe("renamed");
    st.raise("p:a");
    st = useReaderSideChatStore.getState();
    expect(sideChatHolder(st)?.ptyId).toBe("p:a");
    expect(sideChatHolder(st)?.label).toBe("renamed");
  });

  it("leaves the state alone for a repeat want, a raise of the holder or an unknown drop", () => {
    const s = useReaderSideChatStore.getState();
    const showChat = () => {};
    s.want(claim("p:a", "a", showChat));
    const before = useReaderSideChatStore.getState().claims;
    useReaderSideChatStore.getState().want(claim("p:a", "a", showChat));
    useReaderSideChatStore.getState().raise("p:a");
    useReaderSideChatStore.getState().raise("p:zz");
    useReaderSideChatStore.getState().drop("p:zz");
    expect(useReaderSideChatStore.getState().claims).toBe(before);
  });
});

describe("ReaderSideChat cover", () => {
  it("draws nothing and registers no slot while no Reader holds the panel", () => {
    const { container } = render(<ReaderSideChat />);
    expect(container.firstChild).toBeNull();
    expect(useReaderSideChatStore.getState().slot).toBeNull();
  });

  it("names the holder's tab, registers its slot and goes back to Chat", () => {
    const showChat = vi.fn();
    render(<ReaderSideChat />);
    act(() => useReaderSideChatStore.getState().want(claim("p:a", "Fix the parser", showChat)));
    expect(screen.getByText("Fix the parser")).toBeTruthy();
    const slot = useReaderSideChatStore.getState().slot;
    expect(slot?.classList.contains("reader-side-chat-body")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Chat/ }));
    expect(showChat).toHaveBeenCalledTimes(1);
    act(() => useReaderSideChatStore.getState().drop("p:a"));
    expect(useReaderSideChatStore.getState().slot).toBeNull();
  });
});
