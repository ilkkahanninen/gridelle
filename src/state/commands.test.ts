import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "./commands";
import { useEditor } from "./store";

describe("commands", () => {
  const original = useEditor.getState().undo;
  afterEach(() => {
    useEditor.setState({ undo: original });
    vi.useRealTimers();
  });

  it("runs a key press that reaches both the page and the menu bar once, and a key held down every time", () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    useEditor.setState({ undo });
    runCommand("undo", "key");
    runCommand("undo", "menu");
    expect(undo).toHaveBeenCalledTimes(1);
    // The key held down: the page sees it again and again.
    runCommand("undo", "key");
    runCommand("undo", "key");
    expect(undo).toHaveBeenCalledTimes(3);
    // A moment later the menu is a press of its own.
    vi.advanceTimersByTime(1000);
    runCommand("undo", "menu");
    expect(undo).toHaveBeenCalledTimes(4);
    // The other way round too.
    vi.advanceTimersByTime(1000);
    runCommand("undo", "menu");
    runCommand("undo", "key");
    expect(undo).toHaveBeenCalledTimes(5);
  });
});
