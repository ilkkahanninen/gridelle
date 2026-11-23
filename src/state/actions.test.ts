import { beforeEach, describe, expect, it, vi } from "vitest";
import { basicSynth } from "../core/fixtures";

vi.mock("../bridge/organelle", () => ({ sendPatch: vi.fn() }));
vi.mock("../bridge/files", () => ({
  confirm: vi.fn(),
  showError: vi.fn(),
  showInfo: vi.fn(),
  listPresets: vi.fn(),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
  readTextFile: vi.fn(),
}));

import * as files from "../bridge/files";
import { confirm } from "../bridge/files";
import { newPatch } from "../core/fixtures";
import * as ops from "../core/model/ops";
import { serializeDocument } from "../core/model/serialize";
import { sendPatch } from "../bridge/organelle";
import { deletePreset, newPatch as startNew, openPreset, savePatch, sendToOrganelle } from "./actions";
import { usePresets } from "./presets";
import { useOrganelle } from "./organelle";
import { hasUnsavedChanges, useEditor } from "./store";
import { useUi } from "./ui";

const send = vi.mocked(sendPatch);
const ask = vi.mocked(confirm);
const status = () => useOrganelle.getState().status;

describe("sendToOrganelle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditor.getState().load(basicSynth, null);
    useOrganelle.setState({ address: "192.168.1.20", status: { kind: "idle" } });
    useUi.setState({ sidePanes: { left: "presets", right: null } });
    send.mockResolvedValue({ path: "/sdcard/Patches/Basic_Synth", started: true });
  });

  it("sends the compiled patch under its folder name and reports that it is running", async () => {
    await sendToOrganelle();
    expect(send).toHaveBeenCalledTimes(1);
    const [address, folder, files, sounds, replace] = send.mock.calls[0];
    expect(sounds).toEqual([]);
    expect([address, folder, replace]).toEqual(["192.168.1.20", "Basic_Synth", false]);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["main.pd", "voice.pd", "ge-voice.pd"]));
    expect(status()).toEqual({ kind: "sent", message: "Basic_Synth is running on the Organelle." });
    // On its own side: a pane open on the other stays.
    expect(useUi.getState().sidePanes).toEqual({ left: "presets", right: "organelle" });
  });

  it("asks for the address instead of sending when there is none", async () => {
    useOrganelle.setState({ address: "  " });
    await sendToOrganelle();
    expect(send).not.toHaveBeenCalled();
    expect(useOrganelle.getState().status).toEqual({ kind: "idle" });
    expect(useUi.getState().sidePanes.right).toBe("organelle");
  });

  it("says how to start the patch when the Organelle did not start it", async () => {
    send.mockResolvedValue({ path: "/sdcard/Patches/Basic_Synth", started: false });
    await sendToOrganelle();
    expect(status()).toMatchObject({ kind: "sent", message: expect.stringContaining("Pick it from the Organelle's menu") });
  });

  it("asks before replacing a folder Gridelle did not make", async () => {
    send.mockRejectedValueOnce("exists");
    ask.mockResolvedValue(true);
    await sendToOrganelle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map((call) => call[4])).toEqual([false, true]);
    expect(status().kind).toBe("sent");
  });

  it("leaves that folder alone when the answer is no", async () => {
    send.mockRejectedValueOnce("exists");
    ask.mockResolvedValue(false);
    await sendToOrganelle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(status()).toEqual({ kind: "idle" });
  });

  it("shows why sending failed", async () => {
    send.mockRejectedValue("No Organelle found at 192.168.1.20.");
    await sendToOrganelle();
    expect(status()).toEqual({ kind: "error", message: "No Organelle found at 192.168.1.20." });
  });

  it("does not send a patch that does not compile", async () => {
    useEditor.getState().load({ ...basicSynth, voices: 0 }, null);
    await sendToOrganelle();
    expect(send).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ kind: "error", message: expect.stringContaining("Voice count") });
  });

  it("ignores a second request while one is on its way", async () => {
    let finish!: () => void;
    send.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ path: "/sdcard/Patches/Basic_Synth", started: true }))),
    );
    const first = sendToOrganelle();
    expect(status()).toEqual({ kind: "sending" });
    await sendToOrganelle();
    finish();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("presets", () => {
  const DIR = "/Users/someone/Documents/Gridelle";
  const at = (name: string) => `${DIR}/${name}.gridelle`;
  const save = vi.mocked(files.savePreset);
  const list = vi.mocked(files.listPresets);
  const read = vi.mocked(files.readTextFile);
  const remove = vi.mocked(files.deletePreset);
  const showError = vi.mocked(files.showError);
  const rename = (name: string) => useEditor.getState().apply((doc) => ({ ...doc, name }));
  const editor = () => useEditor.getState();

  beforeEach(() => {
    vi.clearAllMocks();
    editor().load(basicSynth, null);
    usePresets.setState({ saved: [], problem: null });
    save.mockImplementation(async (name) => at(name));
    list.mockResolvedValue({ dir: DIR, presets: [{ name: "Basic Synth", path: at("Basic Synth") }] });
    ask.mockResolvedValue(true);
  });

  it("saves a patch that has no file under its name, and lists it", async () => {
    await savePatch();
    expect(save.mock.calls).toEqual([["Basic Synth", serializeDocument(basicSynth), false]]);
    expect(ask).not.toHaveBeenCalled();
    expect(editor().filePath).toBe(at("Basic Synth"));
    expect(hasUnsavedChanges(editor())).toBe(false);
    expect(usePresets.getState().saved).toEqual([{ name: "Basic Synth", path: at("Basic Synth") }]);
  });

  it("writes over the preset that is open without asking", async () => {
    editor().load(basicSynth, at("Basic Synth"));
    editor().apply((doc) => ({ ...doc, voices: 2 }));
    await savePatch();
    expect(save.mock.calls.map(([name, , overwrite]) => [name, overwrite])).toEqual([["Basic Synth", true]]);
    expect(ask).not.toHaveBeenCalled();
    expect(hasUnsavedChanges(editor())).toBe(false);
  });

  it("asks before replacing another preset of the same name", async () => {
    save.mockRejectedValueOnce("exists");
    await savePatch();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain("“Basic Synth” is already saved");
    expect(save.mock.calls.map(([, , overwrite]) => overwrite)).toEqual([false, true]);
    expect(editor().filePath).toBe(at("Basic Synth"));
  });

  it("leaves that preset and the patch as they were when the answer is no", async () => {
    save.mockRejectedValueOnce("exists");
    ask.mockResolvedValue(false);
    editor().apply((doc) => ({ ...doc, voices: 2 }));
    await savePatch();
    expect(save).toHaveBeenCalledTimes(1);
    expect(editor().filePath).toBeNull();
    expect(hasUnsavedChanges(editor())).toBe(true);
    expect(showError).not.toHaveBeenCalled();
  });

  it("saves a renamed patch as a new preset beside the old one", async () => {
    editor().load(basicSynth, at("Basic Synth"));
    rename("Bass / Lead");
    await savePatch();
    // The name loses what a file name cannot hold, and it is not this patch's own file: no overwriting.
    expect(save.mock.calls.map(([name, , overwrite]) => [name, overwrite])).toEqual([["Bass Lead", false]]);
    expect(editor().filePath).toBe(at("Bass Lead"));
    // Saved again under that name, it is its own file.
    await savePatch();
    expect(save.mock.calls[1][2]).toBe(true);
  });

  it("says so when saving fails", async () => {
    save.mockRejectedValueOnce("The folder could not be made.");
    await savePatch();
    expect(showError).toHaveBeenCalledWith("Could not save the preset. The folder could not be made.");
    expect(editor().filePath).toBeNull();
  });

  const file = (name: string) => ({ name, path: at(name) });

  it("opens a preset, pushing apart tiles that an older build left overlapping", async () => {
    const old = { ...newPatch, name: "Old", modules: newPatch.modules.map((m) => ({ ...m, x: 0, y: 0 })) };
    read.mockResolvedValue(serializeDocument(old));
    await openPreset(file("Old"));
    expect(read).toHaveBeenCalledWith(at("Old"));
    expect(editor().doc).toEqual(ops.settle(old));
    expect(editor().filePath).toBe(at("Old"));
    expect(hasUnsavedChanges(editor())).toBe(false);
  });

  it("asks before opening over unsaved changes, and stays when the answer is no", async () => {
    read.mockResolvedValue(serializeDocument(newPatch));
    editor().apply((doc) => ({ ...doc, voices: 2 }));
    const changed = editor().doc;
    ask.mockResolvedValue(false);
    await openPreset(file("Other"));
    await startNew();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
    expect(editor().doc).toBe(changed);
    ask.mockResolvedValue(true);
    await openPreset(file("Other"));
    expect(editor().doc).toEqual(newPatch);
  });

  it("keeps the patch that is open when a preset cannot be read", async () => {
    read.mockResolvedValue("not a patch");
    await openPreset(file("Broken"));
    expect(showError).toHaveBeenCalledWith("Could not open the preset. This file is not a Gridelle patch.");
    expect(editor().doc).toBe(basicSynth);
  });

  it("opens New patch as a copy, so that saving it asks before replacing the base", async () => {
    read.mockResolvedValue(serializeDocument(newPatch));
    await openPreset(file("New patch"));
    expect(editor().doc).toEqual(newPatch);
    expect(editor().filePath).toBeNull();
    // Saved without a new name, it would replace the preset new patches start from: that asks.
    save.mockRejectedValueOnce("exists");
    await savePatch();
    expect(ask.mock.calls[ask.mock.calls.length - 1][0]).toContain("“New patch” is already saved");
    expect(save.mock.calls.map(([name, , overwrite]) => [name, overwrite])).toEqual([["New patch", false], ["New patch", true]]);
  });

  it("starts a new patch from the user's New patch preset, or the built-in one without it", async () => {
    // The user's own base: the preset as they saved it.
    const own = { ...newPatch, voices: 2 };
    usePresets.setState({ saved: [file("Basic Synth"), file("New patch")] });
    read.mockResolvedValue(serializeDocument(own));
    await startNew();
    expect(read).toHaveBeenCalledWith(at("New patch"));
    expect(editor().doc).toEqual(own);
    expect(editor().filePath).toBeNull();
    // The preset cannot be read: the one the editor comes with.
    read.mockRejectedValue("gone");
    await startNew();
    expect(editor().doc).toBe(newPatch);
    // The preset was deleted.
    usePresets.setState({ saved: [file("Basic Synth")] });
    editor().load(basicSynth, at("Basic Synth"));
    read.mockClear();
    await startNew();
    expect(read).not.toHaveBeenCalled();
    expect(editor().doc).toBe(newPatch);
    expect(editor().filePath).toBeNull();
  });

  it("deletes a preset after asking, and the open patch then has no file", async () => {
    const preset = { name: "Basic Synth", path: at("Basic Synth") };
    editor().load(basicSynth, preset.path);
    list.mockResolvedValue({ dir: DIR, presets: [] });
    ask.mockResolvedValue(false);
    await deletePreset(preset);
    expect(remove).not.toHaveBeenCalled();
    expect(editor().filePath).toBe(preset.path);

    ask.mockResolvedValue(true);
    await deletePreset(preset);
    expect(ask.mock.calls[1][0]).toContain("Delete the preset “Basic Synth”?");
    expect(remove).toHaveBeenCalledWith(preset.path);
    expect(editor().filePath).toBeNull();
    expect(editor().doc).toBe(basicSynth);
    expect(usePresets.getState().saved).toEqual([]);
    // Another preset's deletion leaves the open one's file alone.
    editor().load(basicSynth, at("Mine"));
    await deletePreset(preset);
    expect(editor().filePath).toBe(at("Mine"));
  });
});
