import { useEffect } from "react";
import * as ops from "../../core/model/ops";
import { MAX_PAGES } from "../../core/model/types";
import { getModuleDef } from "../../core/modules/registry";
import { armKnob, cancelAssign } from "../../state/assign";
import { useEditor } from "../../state/store";
import { useUi } from "../../state/ui";
import "./KnobPages.css";

/** A caret, pointing the way its button goes. */
function Caret({ to }: { to: "left" | "right" | "down" }) {
  const path = { left: "M7.5 2.5L3.5 6L7.5 9.5", right: "M4.5 2.5L8.5 6L4.5 9.5", down: "M2.5 4.5L6 8.5L9.5 4.5" }[to];
  return (
    <svg className="pages-caret" viewBox="0 0 12 12" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

/**
 * What the Organelle's four knobs control. There are always eight pages, each mapping
 * the knobs to four settings; on the device, Aux steps through those that have a knob in
 * use, and the others are not exported. A page has a colour, which the badges on the
 * tiles' knobs share, and the page shown here has its badges ringed.
 *
 * The row at the top goes from page to page: back, the page's name, a list of all eight
 * to jump to one, and forward.
 *
 * A knob is given a setting by clicking it here while it is unassigned, which arms it
 * (`state/assign.ts`), and then clicking a knob on the grid.
 */
export function KnobPages() {
  const pages = useEditor((s) => s.doc.pages);
  const modules = useEditor((s) => s.doc.modules);
  const apply = useEditor((s) => s.apply);
  const index = useUi((s) => s.knobPage);
  const show = (knobPage: number) => useUi.setState({ knobPage: Math.min(MAX_PAGES - 1, Math.max(0, knobPage)) });
  const assigning = useUi((s) => s.assigning);
  const page = ops.pageAt({ pages }, index);

  // Undo or another patch can leave the armed knob taken.
  useEffect(() => {
    if (assigning && ops.pageAt({ pages }, assigning.page).knobs[assigning.knob] !== null) cancelAssign();
  }, [assigning, pages]);

  return (
    <section className="pages" aria-label="Knob pages">
      <div className={`pages-nav page-color-${index}`}>
        <button className="pages-step" aria-label="Previous page" title="Previous page" disabled={index === 0} onClick={() => show(index - 1)}>
          <Caret to="left" />
        </button>
        <input
          type="text"
          aria-label={`Name of page ${index + 1}`}
          value={page.name}
          placeholder={ops.defaultPageName(index)}
          maxLength={16}
          spellCheck={false}
          onChange={(e) => apply((doc) => ops.renamePage(doc, index, e.target.value), `page-name:${index}`)}
        />
        {/* The list is the system's own, opened from a button that shows only its caret. */}
        <span className="pages-pick" title="Go to a page">
          <select aria-label="Go to a page" value={index} onChange={(e) => show(Number(e.target.value))}>
            {Array.from({ length: MAX_PAGES }, (_, i) => {
              const each = ops.pageAt({ pages }, i);
              return (
                <option key={i} value={i}>
                  {i + 1}. {each.name || ops.defaultPageName(i)}
                  {ops.pageInUse(each) ? "" : " (empty)"}
                </option>
              );
            })}
          </select>
          <Caret to="down" />
        </span>
        <button className="pages-step" aria-label="Next page" title="Next page" disabled={index === MAX_PAGES - 1} onClick={() => show(index + 1)}>
          <Caret to="right" />
        </button>
      </div>

      <ol className={`pages-knobs page-color-${index}`}>
        {page.knobs.map((knob, k) => {
          const module = knob && modules.find((m) => m.id === knob.module);
          const def = module && getModuleDef(module.type);
          const param = def?.params.find((p) => p.id === knob?.param);
          const armed = assigning?.page === index && assigning.knob === k;
          return (
            <li key={k} className={def ? `category-${def.category}` : undefined}>
              <span className={`pages-knob-number${armed ? " pages-knob-number-armed" : ""}`}>{k + 1}</span>
              {module && def && param ? (
                <>
                  <button
                    className="pages-knob-target"
                    title="Show this module"
                    onClick={() => useEditor.getState().select([module.id])}
                  >
                    <span className="pages-swatch" />
                    {ops.moduleName(module, def)} {param.label}
                  </button>
                  <button
                    className="pages-clear"
                    aria-label={`Take ${ops.moduleName(module, def)} ${param.label} off knob ${k + 1}`}
                    title="Take off this knob"
                    onClick={() => apply((doc) => ops.assignKnob(doc, { page: index, knob: k }, null))}
                  >
                    ×
                  </button>
                </>
              ) : (
                <button
                  className="pages-knob-free"
                  aria-pressed={armed}
                  title={armed ? "Click to stop" : `Put a setting on knob ${k + 1}: click here, then a knob on the grid`}
                  onClick={() => (armed ? cancelAssign() : armKnob({ page: index, knob: k }))}
                >
                  {armed ? "Click a knob on the grid" : "Unassigned"}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
