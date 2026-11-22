import { usePreview } from "../../state/preview";
import { Inspector } from "../inspector/Inspector";
import { VirtualOrganelle } from "../organelle/VirtualOrganelle";
import { KnobPages } from "../pages/KnobPages";

/**
 * Bottom strip: the virtual Organelle to play the patch, its knob pages, and the settings
 * of the selected module or of the patch.
 */
export function Dock() {
  const revision = usePreview((s) => s.revision);

  return (
    <footer className="dock">
      <VirtualOrganelle revision={revision} />
      <KnobPages />
      <div className="dock-side">
        <Inspector />
      </div>
    </footer>
  );
}
