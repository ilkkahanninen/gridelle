import { useState } from "react";
import * as ops from "../../core/model/ops";
import { MAX_PAGES } from "../../core/model/types";
import { getModuleDef } from "../../core/modules/registry";
import { useEditor } from "../../state/store";
import "./KnobPages.css";

/**
 * What the Organelle's four knobs control. Each page maps the knobs to four
 * parameters; on the device, Aux steps through the pages.
 */
export function KnobPages() {
  const pages = useEditor((s) => s.doc.pages);
  const modules = useEditor((s) => s.doc.modules);
  const apply = useEditor((s) => s.apply);
  const [shown, setShown] = useState(0);
  const index = Math.min(shown, pages.length - 1);
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
          The Organelle has four knobs. Select a module and put its settings on knobs to play them on the device.
        </p>
      ) : (
        <>
          <div className="pages-tabs" role="tablist">
            {pages.map((p, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === index}
                className={`pages-tab${i === index ? " pages-tab-current" : ""}`}
                onClick={() => setShown(i)}
              >
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

          <ol className="pages-knobs">
            {page.knobs.map((knob, k) => {
              const module = knob && modules.find((m) => m.id === knob.module);
              const def = module && getModuleDef(module.type);
              const param = def?.params.find((p) => p.id === knob?.param);
              return (
                <li key={k} className={def ? `category-${def.category}` : undefined}>
                  <span className="pages-knob-number">{k + 1}</span>
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
                    <span className="pages-knob-free">Free</span>
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
