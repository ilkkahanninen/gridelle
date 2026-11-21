import { beforeEach, describe, expect, it, vi } from "vitest";
import { basicSynth } from "../core/fixtures";

vi.mock("../bridge/organelle", () => ({ sendPatch: vi.fn() }));
vi.mock("../bridge/files", () => ({ confirm: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));

import { confirm } from "../bridge/files";
import { sendPatch } from "../bridge/organelle";
import { sendToOrganelle } from "./actions";
import { useOrganelle } from "./organelle";
import { useEditor } from "./store";

const send = vi.mocked(sendPatch);
const ask = vi.mocked(confirm);
const status = () => useOrganelle.getState().status;

describe("sendToOrganelle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditor.getState().load(basicSynth, null);
    useOrganelle.setState({ address: "192.168.1.20", panelOpen: false, status: { kind: "idle" } });
    send.mockResolvedValue({ path: "/sdcard/Patches/Basic_Synth", started: true });
  });

  it("sends the compiled patch under its folder name and reports that it is running", async () => {
    await sendToOrganelle();
    expect(send).toHaveBeenCalledTimes(1);
    const [address, folder, files, replace] = send.mock.calls[0];
    expect([address, folder, replace]).toEqual(["192.168.1.20", "Basic_Synth", false]);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["main.pd", "voice.pd", "ge-voice.pd"]));
    expect(status()).toEqual({ kind: "sent", message: "Basic_Synth is running on the Organelle." });
    expect(useOrganelle.getState().panelOpen).toBe(true);
  });

  it("asks for the address instead of sending when there is none", async () => {
    useOrganelle.setState({ address: "  " });
    await sendToOrganelle();
    expect(send).not.toHaveBeenCalled();
    expect(useOrganelle.getState()).toMatchObject({ panelOpen: true, status: { kind: "idle" } });
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
    expect(send.mock.calls.map((call) => call[3])).toEqual([false, true]);
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
