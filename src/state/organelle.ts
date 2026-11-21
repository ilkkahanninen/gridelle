import { create } from "zustand";

export type SendStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; message: string }
  | { kind: "error"; message: string };

interface OrganelleState {
  /** Where the Organelle is on the network: an IP address or a host name. Remembered between runs. */
  address: string;
  /** Whether the panel under the Send button is showing. */
  panelOpen: boolean;
  /** How the current or last send went. */
  status: SendStatus;
  setAddress(address: string): void;
}

const ADDRESS_KEY = "gridelle.organelle-address";

// Storage is missing in tests and can be refused by the webview; the address is then
// simply not remembered.
function rememberedAddress(): string {
  try {
    return localStorage.getItem(ADDRESS_KEY) ?? "";
  } catch {
    return "";
  }
}

export const useOrganelle = create<OrganelleState>((set) => ({
  address: rememberedAddress(),
  panelOpen: false,
  status: { kind: "idle" },

  setAddress(address) {
    set({ address });
    try {
      localStorage.setItem(ADDRESS_KEY, address);
    } catch {
      // See above.
    }
  },
}));
