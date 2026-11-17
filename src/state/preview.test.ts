import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basicSynth } from "../core/fixtures";
import * as ops from "../core/model/ops";

vi.mock("../bridge/engine", () => ({
  engine: {
    status: vi.fn(async () => ({ running: true, error: null, sampleRate: 44100 })),
    load: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    peak: vi.fn(async () => 0),
    onEvent: vi.fn(async () => () => {}),
  },
}));

import { engine } from "../bridge/engine";
import { startPreviewSync, usePreview } from "./preview";
import { useEditor } from "./store";

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
      loadsStarted: 0,
      revision: 0,
      log: [],
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

  it("announces a load before it starts, so the screen is cleared before the patch writes to it", async () => {
    const seen: number[] = [];
    load.mockImplementationOnce(async () => void seen.push(usePreview.getState().loadsStarted, usePreview.getState().revision));
    useEditor.getState().apply((doc) => ({ ...doc, voices: 2 }));
    await settle();
    expect(seen).toEqual([2, 1]);
    expect(usePreview.getState()).toMatchObject({ loadsStarted: 2, revision: 2 });
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

  it("sends values that changed while the patch was loading", async () => {
    let finish!: () => void;
    load.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
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
