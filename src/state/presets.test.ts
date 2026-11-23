import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/files", () => ({ listPresets: vi.fn(), seedPresets: vi.fn() }));

import * as files from "../bridge/files";
import { parseDocument } from "../core/model/serialize";
import { EXAMPLE_PRESETS } from "../core/presets";
import { refreshPresets, startPresets, usePresets } from "./presets";

const list = vi.mocked(files.listPresets);
const seed = vi.mocked(files.seedPresets);
const DIR = "/Users/someone/Documents/Gridelle";

describe("the presets folder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePresets.setState({ saved: [], problem: null });
    list.mockResolvedValue({ dir: DIR, presets: [{ name: "Looper", path: `${DIR}/Looper.gridelle` }] });
    seed.mockResolvedValue();
  });

  it("is given the editor's own presets as files when the editor starts, then listed", async () => {
    await startPresets();
    expect(seed).toHaveBeenCalledTimes(1);
    const examples = seed.mock.calls[0][0];
    expect(examples.map((e) => e.name)).toEqual(EXAMPLE_PRESETS.map((p) => p.name));
    // Each is a patch file that opens as the patch it is.
    for (const [i, example] of examples.entries()) expect(parseDocument(example.contents)).toEqual(EXAMPLE_PRESETS[i].doc);
    expect(list.mock.invocationCallOrder[0]).toBeGreaterThan(seed.mock.invocationCallOrder[0]);
    expect(usePresets.getState().saved.map((p) => p.name)).toEqual(["Looper"]);
  });

  it("is still listed when the editor's own presets could not be written", async () => {
    seed.mockRejectedValue("read-only");
    await startPresets();
    expect(usePresets.getState()).toMatchObject({ saved: [{ name: "Looper" }], problem: null });
  });

  it("says why when it cannot be listed", async () => {
    list.mockRejectedValue("The presets could not be listed.");
    await refreshPresets();
    expect(usePresets.getState()).toEqual({ saved: [], problem: "The presets could not be listed." });
  });
});
