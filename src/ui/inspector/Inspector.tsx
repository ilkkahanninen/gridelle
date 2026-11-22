import * as ops from "../../core/model/ops";
import { MAX_VOICES, MIN_VOICES, type ModuleInstance } from "../../core/model/types";
import { formatParam, fromNormalized, toNormalized } from "../../core/modules/params";
import { visibleDef } from "../../core/modules/shape";
import type { ModuleDef, ParamDef } from "../../core/modules/types";
import { usePreview } from "../../state/preview";
import { useEditor } from "../../state/store";
import "./Inspector.css";

const VOICE_SIGNAL = { pitch: "the played note", gate: "the key gate", velocity: "key velocity" } as const;

function ParamRow({ module, param }: { module: ModuleInstance; param: ParamDef }) {
  const value = ops.paramValue(module, param.id);
  const set = (next: number, coalesce: boolean) =>
    useEditor
      .getState()
      .apply((doc) => ops.setParam(doc, module.id, param.id, next), coalesce ? `param:${module.id}:${param.id}` : undefined);
  const id = `param-${module.id}-${param.id}`;
  return (
    <div className="inspector-param">
      <label htmlFor={id}>{param.label}</label>
      <output>{formatParam(param, value)}</output>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={toNormalized(param, value)}
        onChange={(e) => set(fromNormalized(param, Number(e.target.value)), true)}
        onDoubleClick={() => set(param.default, false)}
      />
    </div>
  );
}

/** A setting that is one of a few named options. */
function ChoiceRow({ module, param }: { module: ModuleInstance; param: ParamDef }) {
  const id = `param-${module.id}-${param.id}`;
  return (
    <div className="inspector-param inspector-choice">
      <label htmlFor={id}>{param.label}</label>
      <select
        id={id}
        value={ops.paramValue(module, param.id)}
        onChange={(e) =>
          useEditor.getState().apply((doc) => ops.setParam(doc, module.id, param.id, Number(e.target.value)))
        }
      >
        {param.options!.map((option, i) => (
          <option key={option} value={i}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function ModuleInspector({ module, def }: { module: ModuleInstance; def: ModuleDef }) {
  const cables = useEditor((s) => s.doc.cables);
  const precordPorts = def.inputs.filter((p) => p.precord);
  return (
    <>
      <header className={`inspector-title category-${def.category}`}>
        <span className="inspector-swatch" />
        <h2>{def.name}</h2>
      </header>

      {def.params.length > 0 ? (
        <section>
          {def.params.map((param) =>
            param.options ? (
              <ChoiceRow key={param.id} module={module} param={param} />
            ) : (
              <ParamRow key={param.id} module={module} param={param} />
            ),
          )}
          <p className="inspector-note">Double-click a control to reset it.</p>
        </section>
      ) : (
        <p className="inspector-note">This module has no settings.</p>
      )}

      {precordPorts.length > 0 && (
        <section>
          <h3>Automatic connections</h3>
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
    <aside className="inspector" aria-label="Inspector">
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
