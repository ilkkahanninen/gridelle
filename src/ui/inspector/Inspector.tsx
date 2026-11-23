import * as ops from "../../core/model/ops";
import { MAX_VOICES, MIN_VOICES, SAMPLE_PARAM, sampleLetter, type ModuleInstance } from "../../core/model/types";
import { MODULE_DOCS } from "../../core/modules/docs";
import { visibleDef } from "../../core/modules/shape";
import type { ModuleDef, ParamDef } from "../../core/modules/types";
import { usePreview } from "../../state/preview";
import { useEditor } from "../../state/store";
import { describeSample } from "../samples/SamplesPane";
import "./Inspector.css";

const VOICE_SIGNAL = { pitch: "the played note", gate: "the key gate", velocity: "key velocity" } as const;

/** A setting that is one of a few named options. */
function ChoiceRow({ module, param }: { module: ModuleInstance; param: ParamDef }) {
  const id = `param-${module.id}-${param.id}`;
  const value = ops.paramValue(module, param.id);
  // The Sample choice offers the samples the patch has (they are made in the Samples pane),
  // and says what each holds. The one the module is on is offered even when it is empty.
  const isSample = param.id === SAMPLE_PARAM;
  const samples = useEditor((s) => (isSample ? s.doc.samples : undefined));
  const offered = (i: number) => !isSample || i === value || !!samples?.[i];
  const text = (option: string, i: number) => (isSample ? `${sampleLetter(i)}: ${describeSample(samples?.[i] ?? null)}` : option);
  return (
    <div className="inspector-param inspector-choice">
      <label htmlFor={id}>{param.label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) =>
          useEditor.getState().apply((doc) => ops.setParam(doc, module.id, param.id, Number(e.target.value)))
        }
      >
        {param.options!.map(
          (option, i) =>
            offered(i) && (
              <option key={option} value={i}>
                {text(option, i)}
              </option>
            ),
        )}
      </select>
    </div>
  );
}

/**
 * What the module does, and what it has besides the knobs on its tile: its choices, and
 * whether its inputs follow the played note while nothing is patched into them.
 */
function ModuleInspector({ module, def }: { module: ModuleInstance; def: ModuleDef }) {
  const cables = useEditor((s) => s.doc.cables);
  const precordPorts = def.inputs.filter((p) => p.precord);
  const choices = def.params.filter((param) => param.options);
  return (
    <>
      <header className={`inspector-title category-${def.category}`}>
        <span className="inspector-swatch" />
        <h2>{def.name}</h2>
      </header>

      {MODULE_DOCS[def.type] && (
        <section className="inspector-doc">
          <p>{MODULE_DOCS[def.type]}</p>
        </section>
      )}

      {choices.length > 0 && (
        <section>
          {choices.map((param) => (
            <ChoiceRow key={param.id} module={module} param={param} />
          ))}
        </section>
      )}

      {precordPorts.length > 0 && (
        <section>
          {precordPorts.map((port) => {
            const cabled = cables.some((c) => c.to.module === module.id && c.to.port === port.id);
            return (
              <label key={port.id} className="inspector-check">
                <input
                  type="checkbox"
                  disabled={cabled}
                  checked={!cabled && (module.precords?.[port.id] ?? true)}
                  onChange={(e) =>
                    useEditor.getState().apply((doc) => ops.setPrecord(doc, module.id, port.id, e.target.checked))
                  }
                />
                <span>
                  {port.label} follows {VOICE_SIGNAL[port.precord!]}
                  {cabled && " (replaced by a cable)"}
                </span>
              </label>
            );
          })}
        </section>
      )}
    </>
  );
}

function PatchInspector() {
  const name = useEditor((s) => s.doc.name);
  const voices = useEditor((s) => s.doc.voices);
  const diagnostics = usePreview((s) => s.diagnostics);
  const apply = useEditor((s) => s.apply);
  return (
    <>
      <header className="inspector-title">
        <h2>Patch</h2>
      </header>
      <section>
        <label className="inspector-field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            maxLength={40}
            spellCheck={false}
            onChange={(e) => apply((doc) => ({ ...doc, name: e.target.value }), "patch-name")}
          />
        </label>
        <label className="inspector-field">
          <span>Voices</span>
          <input
            type="number"
            min={MIN_VOICES}
            max={MAX_VOICES}
            value={voices}
            onChange={(e) => {
              const next = Math.round(Number(e.target.value));
              if (next >= MIN_VOICES && next <= MAX_VOICES) apply((doc) => ({ ...doc, voices: next }));
            }}
          />
        </label>
        <p className="inspector-note">
          Each voice runs its own copy of the modules. Modules placed after a Voice Sum run once for all voices.
        </p>
      </section>

      {diagnostics.length > 0 && (
        <section>
          <h3>Problems</h3>
          <ul className="inspector-problems">
            {diagnostics.map((d, i) => (
              <li key={i} className={`problem-${d.severity}`}>
                {d.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const modules = useEditor((s) => s.doc.modules);
  const cables = useEditor((s) => s.doc.cables);
  const selected = modules.filter((m) => selection.has(m.id));
  const single = selected.length === 1 ? selected[0] : null;
  // A mixer shows the settings of the inputs it currently has.
  const def = single ? visibleDef({ cables }, single) : undefined;

  return (
    <aside className="inspector" aria-label="Settings">
      {single && def ? (
        <ModuleInspector module={single} def={def} />
      ) : selected.length > 1 ? (
        <header className="inspector-title">
          <h2>{selected.length} modules selected</h2>
        </header>
      ) : (
        <PatchInspector />
      )}
    </aside>
  );
}
