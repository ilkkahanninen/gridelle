import { useState } from "react";
import { moduleDefs } from "../../core/modules/registry";
import { visiblePairs } from "../../core/modules/shape";
import type { Category, ModuleDef, PortDef } from "../../core/modules/types";
import { GROUP_PLACING, useUi } from "../../state/ui";
import { GLYPHS } from "./glyphs";
import "./Palette.css";

const CATEGORY_NAMES: Record<Category, string> = {
  io: "In / Out",
  sample: "Sample",
  oscillator: "Oscillator",
  envelope: "Envelope",
  lfo: "LFO",
  filter: "Filter",
  shaper: "Shaper",
  level: "Level & Mix",
  pitch: "Pitch",
  random: "Random",
  fx: "Delay & FX",
  math: "Math",
  logic: "Logic",
  sequence: "Sequence",
};

/** The categories that have modules, in the order of the selector, each with its modules. */
const GROUPS = (Object.keys(CATEGORY_NAMES) as Category[])
  .map((category) => ({ category, defs: moduleDefs.filter((def) => def.category === category) }))
  .filter((group) => group.defs.length > 0);

/** The inputs a module has when it lands on the grid: a mixer starts with one. */
const freshInputs = (def: ModuleDef) =>
  def.growsWithInputs ? def.inputs.slice(0, visiblePairs(def, { id: "" }, [])) : def.inputs;

const describe = (def: ModuleDef) => {
  const ins = freshInputs(def).map((p) => p.label).join(", ") || "none";
  const outs = def.outputs.map((p) => p.label).join(", ") || "none";
  return `${def.name}. Inputs: ${ins}. Outputs: ${outs}. Drag onto the grid, or click to add.`;
};

function Ports({ ports, side }: { ports: PortDef[]; side: "in" | "out" }) {
  return (
    <span className={`palette-ports palette-ports-${side}`}>
      {ports.map((port) => (
        <span key={port.id} className={`palette-port hint-${port.hint}`} />
      ))}
    </span>
  );
}

/** The browser's kinds: the categories of modules, and the containers that hold modules. */
type Kind = Category | "groups";

/** The picture on the Unison card: one line becoming several. */
const UNISON_GLYPH = "M2 10H9 M9 10L26 4 M9 10H26 M9 10L26 16";

/** A unison group in the browser, to drag onto the grid like a module. */
function GroupCard({ active }: { active: boolean }) {
  return (
    <button
      className={`palette-item${active ? " palette-item-active" : ""}`}
      title="Unison group. What is put in it runs several times side by side, added up where its cables leave it: a Unison Index in it can detune the copies. Drag onto the grid, or click to add."
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        useUi.setState({ placing: GROUP_PLACING });
      }}
    >
      <span className="palette-card palette-card-group">
        <svg className="palette-glyph" viewBox="0 0 28 20" aria-hidden="true">
          <path d={UNISON_GLYPH} />
        </svg>
      </span>
      <span className="palette-name">Unison</span>
    </button>
  );
}

/** A module in the browser: a small tile with its ports and picture, and its name below. */
function ModuleCard({ def, active }: { def: ModuleDef; active: boolean }) {
  return (
    <button
      className={`palette-item${active ? " palette-item-active" : ""}`}
      title={describe(def)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        useUi.setState({ placing: def.type });
      }}
    >
      <span className="palette-card">
        <Ports ports={freshInputs(def)} side="in" />
        <svg className="palette-glyph" viewBox="0 0 28 20" aria-hidden="true">
          <path d={GLYPHS[def.type] ?? ""} />
        </svg>
        <Ports ports={def.outputs} side="out" />
      </span>
      <span className="palette-name">{def.name}</span>
    </button>
  );
}

/**
 * The module browser, a strip above the grid: pick a kind of module on the left, then
 * press and drag one of that kind onto the grid, or click it to drop it near the centre.
 */
export function Palette() {
  const placing = useUi((s) => s.placing);
  const [category, setCategory] = useState<Kind>("oscillator");
  const groups = category === "groups";
  const group = GROUPS.find((g) => g.category === category) ?? GROUPS[0];

  return (
    <nav className="palette" aria-label="Modules">
      <div className="palette-categories" role="group" aria-label="Kind of module">
        {GROUPS.map((g) => (
          <button
            key={g.category}
            className={`palette-category category-${g.category}${g === group ? " palette-category-selected" : ""}`}
            aria-pressed={g === group}
            onClick={() => setCategory(g.category)}
          >
            <span className="palette-swatch" />
            {CATEGORY_NAMES[g.category]}
          </button>
        ))}
        <button
          className={`palette-category category-groups${groups ? " palette-category-selected" : ""}`}
          aria-pressed={groups}
          onClick={() => setCategory("groups")}
        >
          <span className="palette-swatch" />
          Groups
        </button>
      </div>
      <div
        className={`palette-modules category-${groups ? "groups" : group.category}`}
        // A mouse wheel only turns one way; let it move the row sideways.
        onWheel={(e) => {
          if (!e.deltaX) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {groups ? (
          <GroupCard active={placing === GROUP_PLACING} />
        ) : (
          group.defs.map((def) => <ModuleCard key={def.type} def={def} active={placing === def.type} />)
        )}
      </div>
    </nav>
  );
}
