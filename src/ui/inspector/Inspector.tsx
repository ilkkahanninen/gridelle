import * as ops from "../../core/model/ops";
import {
  MAX_MODULE_NAME,
  MAX_VOICES,
  MIN_VOICES,
  SAMPLE_PARAM,
  sampleLetter,
  type ModuleInstance,
} from "../../core/model/types";
import { MODULE_DOCS } from "../../core/modules/docs";
import { getModuleDef } from "../../core/modules/registry";
import { wavetableGroups } from "../../core/wavetables/banks";
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
  // The Sample choice offers the samples the patch has (they are made in the Samples pane)
  // that the module can use, and says what each holds: a Wavetable oscillator reads a
  // wavetable or a sound file, the sample modules a sound file or a tape. The one the
  // module is on is offered whatever it holds.
  const isSample = param.id === SAMPLE_PARAM;
  const scans = isSample && getModuleDef(module.type)?.sample === "wavetable";
  const samples = useEditor((s) => (isSample ? s.doc.samples : undefined));
  const usable = (i: number) => {
    const kind = samples?.[i]?.kind;
    return kind === "file" || kind === (scans ? "wavetable" : "tape");
  };
  const offered = (i: number) => !isSample || i === value || usable(i);
  const text = (option: string, i: number) => (isSample ? `${sampleLetter(i)}: ${describeSample(samples?.[i] ?? null)}` : option);
  // For a Wavetable oscillator the list goes on with every wavetable the editor has:
  // choosing one puts it in a slot of the patch (`ops.setWavetable`) and the module on that.
  const BANK = "bank:";
  const choose = (chosen: string) =>
    useEditor
      .getState()
      .apply((doc) =>
        chosen.startsWith(BANK) ? ops.setWavetable(doc, module.id, chosen.slice(BANK.length)) : ops.setParam(doc, module.id, param.id, Number(chosen)),
      );
  const slots = param.options!.map(
    (option, i) =>
      offered(i) && (
        <option key={option} value={i}>
          {text(option, i)}
        </option>
      ),
  );
  return (
    <div className="inspector-param inspector-choice">
      <label htmlFor={id}>{param.label}</label>
      <select id={id} value={value} onChange={(e) => choose(e.target.value)}>
        {scans ? <optgroup label="In this patch">{slots}</optgroup> : slots}
        {scans &&
          wavetableGroups().map(({ group, banks }) => (
            <optgroup key={group} label={group}>
              {banks.map((bank) => (
                <option key={bank.id} value={BANK + bank.id}>
                  {bank.name}
                </option>
              ))}
            </optgroup>
          ))}
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
        {/* The module's name: its type's until it is given one of its own. */}
        <input
          className="heading-field inspector-name"
          type="text"
          aria-label="Module name"
          value={module.name ?? ""}
          placeholder={def.name}
          maxLength={MAX_MODULE_NAME}
          spellCheck={false}
          onChange={(e) =>
            useEditor.getState().apply((doc) => ops.renameModule(doc, module.id, e.target.value), `module-name:${module.id}`)
          }
        />
        {module.name?.trim() && <span className="inspector-type">{def.name}</span>}
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
        {/* The patch's name, to type over like a module's. */}
        <input
          className="heading-field inspector-name inspector-name-patch"
          type="text"
          aria-label="Patch name"
          value={name}
          placeholder="Untitled"
          maxLength={40}
          spellCheck={false}
          onChange={(e) => apply((doc) => ({ ...doc, name: e.target.value }), "patch-name")}
        />
      </header>
      <section>
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
      </section>
      {/* The width of the pane, like what a module's pane says of the module. */}
      <section className="inspector-doc">
        <p>
          Each voice runs its own copy of the modules, all the time: an oscillator sounds whether or not a key is down, on middle C
          until its voice gets a note. An Amp with an envelope gives notes a beginning and an end. Modules placed after a Voice Sum
          run once for all voices.
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
