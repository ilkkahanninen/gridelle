import type { AbstractionLibrary } from "./compiler";

const files = import.meta.glob<string>("../../pd-lib/modules/*.pd", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The hand-written module abstractions in `pd-lib/modules`, by name without `.pd`. */
export const abstractionLibrary: AbstractionLibrary = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.split("/").pop()!.replace(/\.pd$/, ""), text]),
);
