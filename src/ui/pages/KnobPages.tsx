import { useEffect } from "react";
import * as ops from "../../core/model/ops";
import { MAX_PAGES } from "../../core/model/types";
import { getModuleDef } from "../../core/modules/registry";
import { armKnob, cancelAssign } from "../../state/assign";
import { useEditor } from "../../state/store";
import { shownKnobPage, useUi } from "../../state/ui";
import "./KnobPages.css";

/**
 * What the Organelle's four knobs control. Each page maps the knobs to four
 * parameters; on the device, Aux steps through the pages. A page has a colour, which
 * the badges on the tiles' knobs share, and the page shown here has its badges ringed.
 *
 * A knob is given a setting by clicking it here while it is unassigned, which arms it
 * (`state/assign.ts`), and then clicking a knob on the grid.
 */
export function KnobPages() {
  const pages = useEditor((s) => s.doc.pages);
  const modules = useEditor((s) => s.doc.modules);
  const apply = useEditor((s) => s.apply);
  const index = shownKnobPage(useUi((s) => s.knobPage), pages.length);
  const setShown = (knobPage: number) => useUi.setState({ knobPage });
  const assigning = useUi((s) => s.assigning);

  // Undo, a removed page or another patch can leave the armed knob taken or gone.
  useEffect(() => {
    if (assigning && pages[assigning.page]?.knobs[assigning.knob] !== null) cancelAssign();
  }, [assigning, pages]);
  const page = pages[index];

  const addPage = () => {
    apply((doc) => ops.addPage(doc));
    setShown(pages.length);
  };

  return (
    <section className="pages" aria-label="Knob pages">
      <header className="pages-head">
        <h2>Knob pages</h2>
        <button className="button" onClick={addPage} disabled={pages.length >= MAX_PAGES}>
          Add page
        </button>
      </header>

      {!page ? (
        <p className="pages-empty">
          The Organelle has four knobs. Add a page, then click one of its knobs here and a knob on the grid to play
          that setting on the device.
        </p>
      ) : (
        <>
          <div className="pages-tabs" role="tablist">
            {pages.map((p, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === index}
                className={`pages-tab page-color-${i}${i === index ? " pages-tab-current" : ""}`}
                onClick={() => setShown(i)}
              >
                <span className="pages-tab-dot" />
                {p.name || `Page ${i + 1}`}
              </button>
            ))}
          </div>

          <div className="pages-name">
            <input
              type="text"
              aria-label="Page name"
              value={page.name}
              maxLength={16}
              spellCheck={false}
              onChange={(e) => apply((doc) => ops.renamePage(doc, index, e.target.value), `page-name:${index}`)}
            />
            <button className="button button-danger" onClick={() => apply((doc) => ops.removePage(doc, index))}>
              Remove page
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
                        {def.name} {param.label}
                      </button>
                      <button
                        className="pages-clear"
                        aria-label={`Take ${def.name} ${param.label} off knob ${k + 1}`}
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
        </>
      )}
    </section>
  );
}
