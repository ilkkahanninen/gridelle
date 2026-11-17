import { moduleDefs } from "../../core/modules/registry";
import type { Category, ModuleDef } from "../../core/modules/types";
import { useUi } from "../../state/ui";
import "./Palette.css";

const CATEGORY_NAMES: Record<Category, string> = {
  io: "In / Out",
  oscillator: "Oscillators",
  envelope: "Envelopes",
  lfo: "LFOs",
  filter: "Filters",
  level: "Level & mix",
  pitch: "Pitch",
  shaper: "Shapers",
  random: "Random",
  fx: "Delay & effects",
};

const CATEGORY_ORDER = Object.keys(CATEGORY_NAMES) as Category[];

const describe = (def: ModuleDef) => {
  const ins = def.inputs.map((p) => p.label).join(", ") || "none";
  const outs = def.outputs.map((p) => p.label).join(", ") || "none";
  return `${def.name}. Inputs: ${ins}. Outputs: ${outs}. Drag onto the grid, or click to add.`;
};

/** The module browser: press and drag a module onto the grid, or click to drop it near the centre. */
export function Palette() {
  const placing = useUi((s) => s.placing);
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    defs: moduleDefs.filter((d) => d.category === category),
  })).filter((g) => g.defs.length > 0);

  return (
    <nav className="palette" aria-label="Modules">
      {groups.map(({ category, defs }) => (
        <section key={category} className={`palette-group category-${category}`}>
          <h2>{CATEGORY_NAMES[category]}</h2>
          {defs.map((def) => (
            <button
              key={def.type}
              className={`palette-item${placing === def.type ? " palette-item-active" : ""}`}
              title={describe(def)}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                useUi.setState({ placing: def.type });
              }}
            >
              <span className="palette-swatch" />
              {def.name}
            </button>
          ))}
        </section>
      ))}
    </nav>
  );
}
