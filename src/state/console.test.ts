import { describe, expect, it } from "vitest";
import { CONSOLE_LINES, consoleLine, withLine } from "./console";

describe("Pd's console", () => {
  it("reads the level libpd marks a line with", () => {
    // As libpd printed them for a patch with a missing object, a message to nobody and a [print].
    expect(consoleLine("verbose(0): nonexistent-thing 1 2")).toEqual({ text: "nonexistent-thing 1 2", error: true });
    expect(consoleLine("verbose(1): ... couldn't create")).toEqual({ text: "... couldn't create", error: true });
    expect(consoleLine("error: nobody: no such object")).toEqual({ text: "nobody: no such object", error: true });
    expect(consoleLine("hello: bang")).toEqual({ text: "hello: bang", error: false });
    expect(consoleLine("verbose(2): a post")).toEqual({ text: "a post", error: false });
    expect(consoleLine("verbose(4): tried /some/path and failed")).toBeNull();
  });

  it("does not repeat a line, and keeps the latest", () => {
    const a = { text: "a", error: true };
    const once = withLine([], a);
    expect(withLine(once, { ...a })).toBe(once);
    expect(withLine(once, { text: "a", error: false })).toHaveLength(2);
    let many = once;
    for (let i = 0; i < CONSOLE_LINES + 5; i++) many = withLine(many, { text: `line ${i}`, error: false });
    expect(many).toHaveLength(CONSOLE_LINES);
    expect(many[many.length - 1].text).toBe(`line ${CONSOLE_LINES + 4}`);
  });
});
