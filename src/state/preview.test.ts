import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basicSynth } from "../core/fixtures";
import * as ops from "../core/model/ops";

vi.mock("../bridge/engine", () => ({
  engine: {
    status: vi.fn(async () => ({ running: true, error: null, sampleRate: 44100 })),
    load: vi.fn(async () => null),
    scope: vi.fn(async () => []),
    send: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    levels: vi.fn(async () => [0, 0, 0, 0]),
    onEvent: vi.fn(async () => () => {}),
  },
}));

import { engine } from "../bridge/engine";
import { dismissConsole, startPreviewSync, usePreview } from "./preview";
import { useEditor } from "./store";
import { useUi } from "./ui";

const load = vi.mocked(engine.load);
const send = vi.mocked(engine.send);
const settle = () => vi.advanceTimersByTimeAsync(500);

describe("preview sync", () => {
  let stop: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useEditor.getState().load(basicSynth, null);
    usePreview.setState({
      engine: { kind: "starting" },
      diagnostics: [],
      screen: ["", "", "", "", ""],
      led: 0,
      revision: 0,
      console: [],
      loadError: null,
    });
    stop = startPreviewSync();
    await settle();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("loads the compiled patch once the engine is ready", () => {
    expect(load).toHaveBeenCalledTimes(1);
    const [files, entry] = load.mock.calls[0];
    expect(entry).toBe("main.pd");
    expect(Object.keys(files)).toContain("voice.pd");
    expect(usePreview.getState()).toMatchObject({ engine: { kind: "ready", sampleRate: 44100 }, revision: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps what the patch sends to the screen and the LED", () => {
    const emit = vi.mocked(engine.onEvent).mock.calls[0][0];
    emit({ kind: "message", recv: "screenLine2", atoms: ["Low-pass", "Res", 0.30000001192092896] });
    emit({ kind: "message", recv: "screenLine5", atoms: ["A", "page", "name", "that", "is", "far", "too", "long"] });
    emit({ kind: "message", recv: "led", atoms: [4] });
    expect(usePreview.getState().screen).toEqual(["", "Low-pass Res 0.3", "", "", "A page name that is f"]);
    expect(usePreview.getState().led).toBe(4);
  });

  it("blanks the screen before a load starts, so the new patch writes onto an empty screen", async () => {
    const emit = vi.mocked(engine.onEvent).mock.calls[0][0];
    emit({ kind: "message", recv: "screenLine1", atoms: ["Old"] });
    emit({ kind: "message", recv: "led", atoms: [3] });
    let atLoad: unknown;
    load.mockImplementationOnce(async () => {
      const { screen, led, revision } = usePreview.getState();
      atLoad = { screen, led, revision };
      // The patch writes to the screen while it loads.
      emit({ kind: "message", recv: "screenLine1", atoms: ["New"] });
      return null;
    });
    useEditor.getState().apply((doc) => ({ ...doc, voices: 2 }));
    await settle();
    expect(atLoad).toEqual({ screen: ["", "", "", "", ""], led: 0, revision: 1 });
    expect(usePreview.getState()).toMatchObject({ screen: ["New", "", "", "", ""], revision: 2 });
  });

  it("shows what Pd prints, and opens the Problems pane for an error", () => {
    useUi.setState({ sidePanes: { left: null, right: null } });
    const emit = vi.mocked(engine.onEvent).mock.calls[0][0];
    emit({ kind: "print", text: "hello: bang" });
    expect(usePreview.getState().console).toEqual([{ text: "hello: bang", error: false }]);
    expect(useUi.getState().sidePanes.right).toBeNull();
    emit({ kind: "print", text: "error: nobody: no such object" });
    expect(usePreview.getState().console).toHaveLength(2);
    expect(useUi.getState().sidePanes.right).toBe("problems");
    // Closed while the error stands, it stays closed when the error is printed again.
    useUi.setState({ sidePanes: { left: null, right: null } });
    emit({ kind: "print", text: "error: nobody: no such object" });
    expect(useUi.getState().sidePanes.right).toBeNull();
    // Dismissed, the lines go, and so does the pane.
    useUi.setState({ sidePanes: { left: null, right: "problems" } });
    dismissConsole();
    expect(usePreview.getState().console).toEqual([]);
    expect(useUi.getState().sidePanes.right).toBeNull();
  });

  it("sends a changed parameter to its receiver without reloading", async () => {
    useEditor.getState().apply((doc) => ops.setParam(doc, "ge5", "decay", 900));
    await settle();
    expect(send.mock.calls).toEqual([["ge5-decay", 900]]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("also moves the hardware knob that controls the parameter", async () => {
    // ge2 res is on knob 2 of the first page; its range is 0–1, so position equals value.
    useEditor.getState().apply((doc) => ops.setParam(doc, "ge2", "res", 0.25));
    await settle();
    expect(send.mock.calls).toEqual([
      ["ge2-res", 0.25],
      ["ge-slot-0-2", 0.25],
    ]);
  });

  it("reloads when a knob assignment changes", async () => {
    useEditor.getState().apply((doc) => ops.assignKnob(doc, { page: 1, knob: 1 }, { module: "ge6", param: "decay" }));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not reload when a tile moves or the patch is renamed", async () => {
    useEditor.getState().apply((doc) => ops.moveModules(doc, new Set(["ge1"]), { x: 0, y: -3 }));
    useEditor.getState().apply((doc) => ({ ...doc, name: "Renamed" }));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("reloads once after a burst of structural edits", async () => {
    const { apply } = useEditor.getState();
    apply((doc) => ops.addModule(doc, "amp", { x: 9, y: 0 }).doc);
    apply((doc) => ops.connect(doc, { module: "ge1", port: "out" }, { module: "ge7", port: "in" }));
    apply((doc) => ({ ...doc, voices: 6 }));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1][0]["main.pd"]).toContain("clone voice 6;");
    expect(usePreview.getState().revision).toBe(2);
  });

  it("keeps why the audio input is missing, and forgets it at the next load that has it", async () => {
    load.mockImplementationOnce(async () => "No audio input device was found.");
    useEditor.getState().apply((doc) => ({ ...doc, voices: 2 }));
    await settle();
    expect(usePreview.getState().inputProblem).toBe("No audio input device was found.");
    expect(usePreview.getState().loadError).toBeNull();
    useEditor.getState().apply((doc) => ({ ...doc, voices: 3 }));
    await settle();
    expect(usePreview.getState().inputProblem).toBeNull();
  });

  it("sends values that changed while the patch was loading", async () => {
    let finish!: () => void;
    load.mockImplementationOnce(() => new Promise<null>((resolve) => (finish = () => resolve(null))));
    useEditor.getState().apply((doc) => ({ ...doc, voices: 2 }));
    await settle();
    useEditor.getState().apply((doc) => ops.setParam(doc, "ge5", "sustain", 0.9));
    finish();
    await settle();
    expect(send.mock.calls).toEqual([["ge5-sustain", 0.9]]);
  });

  it("keeps the old patch playing and reports problems when the patch is invalid", async () => {
    useEditor.getState().apply((doc) => ({ ...doc, voices: 0 }));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(usePreview.getState().diagnostics.map((d) => d.code)).toEqual(["voice-count"]);
  });

  it("reports a patch the engine refuses", async () => {
    load.mockRejectedValueOnce("could not open main.pd");
    useEditor.getState().apply((doc) => ({ ...doc, voices: 3 }));
    await settle();
    expect(usePreview.getState().loadError).toBe("could not open main.pd");
  });

  it("stops syncing when stopped", async () => {
    stop();
    useEditor.getState().apply((doc) => ({ ...doc, voices: 5 }));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
