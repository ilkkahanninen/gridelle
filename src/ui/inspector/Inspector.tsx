import { placement } from "../../core/model/area";
import * as ops from "../../core/model/ops";
import {
  MAX_DETUNE,
  MAX_MODULE_NAME,
  MAX_VOICES,
  MIN_VOICES,
  SAMPLE_PARAM,
  sampleLetter,
  voiceCopies,
  voicingOf,
  type ModuleInstance,
  type NotePriority,
  type Voicing,
} from "../../core/model/types";
import { MODULE_DOCS } from "../../core/modules/docs";
import { getModuleDef } from "../../core/modules/registry";
import { wavetableGroups } from "../../core/wavetables/banks";
import { visibleDef } from "../../core/modules/shape";
import type { ModuleDef, ParamDef } from "../../core/modules/types";
import { usePreview } from "../../state/preview";
import { useEditor } from "../../state/store";
import { describeSample } from "../samples/SamplesPane";
import { precordText } from "../precordText";
import "./Inspector.css";


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
  const inVoices = useEditor((s) => placement(s.doc, module) === "inside");
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
                  {port.label} follows {precordText(port.precord!, inVoices)}
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

const PRIORITIES: [NotePriority, string][] = [
  ["last", "Last pressed"],
  ["low", "Lowest"],
  ["high", "Highest"],
];

/** How the voices play notes: poly or mono, Unison and Detune, and for mono which key and legato. */
function VoiceSettings() {
  const voices = useEditor((s) => s.doc.voices);
  const voicing = useEditor((s) => voicingOf(s.doc));
  const copies = useEditor((s) => voiceCopies(s.doc));
  const apply = useEditor((s) => s.apply);
  const set = (change: Partial<Voicing>, coalesce?: string) => apply((doc) => ops.setVoicing(doc, change), coalesce);
  const mono = voicing.mode === "mono";
  const { unison, detune } = voicing;
  const whole = (text: string) => Math.round(Number(text));
  const notes = mono ? "One note at a time" : `${voices} ${voices === 1 ? "note" : "notes"} at once`;
  const each = unison > 1 ? `${mono ? "" : ","} ${mono ? "on" : "each on"} ${unison} voices, up to ${detune} cents off the note` : "";
  return (
    <section>
      <h3>Voices</h3>
      <div className="inspector-param inspector-choice">
        <label htmlFor="voice-mode">Mode</label>
        <select id="voice-mode" value={voicing.mode} onChange={(e) => set({ mode: e.target.value as Voicing["mode"] })}>
          <option value="poly">Poly</option>
          <option value="mono">Mono</option>
        </select>
      </div>
      {!mono && (
        <label className="inspector-field">
          <span>Voices</span>
          <input
            type="number"
            min={MIN_VOICES}
            max={Math.floor(MAX_VOICES / unison)}
            value={voices}
            onChange={(e) => apply((doc) => ops.setVoices(doc, whole(e.target.value)))}
          />
        </label>
      )}
      <label className="inspector-field">
        <span>Unison</span>
        <input
          type="number"
          min={1}
          max={Math.floor(MAX_VOICES / (mono ? 1 : voices))}
          value={unison}
          onChange={(e) => set({ unison: whole(e.target.value) })}
        />
      </label>
      {unison > 1 && (
        <label className="inspector-field inspector-range">
          <span>Detune</span>
          <input
            type="range"
            min={0}
            max={MAX_DETUNE}
            step={1}
            value={detune}
            onChange={(e) => set({ detune: Number(e.target.value) }, "voice-detune")}
          />
          <output>{detune} ct</output>
        </label>
      )}
      {mono && (
        <>
          <div className="inspector-param inspector-choice">
            <label htmlFor="voice-priority">Priority</label>
            <select id="voice-priority" value={voicing.priority} onChange={(e) => set({ priority: e.target.value as NotePriority })}>
              {PRIORITIES.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </div>
          <label className="inspector-check">
            <input type="checkbox" checked={voicing.legato} onChange={(e) => set({ legato: e.target.checked })} />
            <span>Legato: a key played while another is held changes the pitch without starting the note again</span>
          </label>
        </>
      )}
      <p className="inspector-note">
        {notes}
        {each}. {copies} {copies === 1 ? "copy" : "copies"} of the voice area {copies === 1 ? "runs" : "run"}.
      </p>
    </section>
  );
}

function PatchInspector() {
  const name = useEditor((s) => s.doc.name);
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
      {/* The width of the pane, like what a module's pane says of the module. */}
      <section className="inspector-doc">
        <p>
          Each voice runs its own copy of the modules in the voice area, all the time: an oscillator there sounds whether or not
          a key is down, on C3 until its voice gets a note. An Amp with an envelope gives notes a beginning and an end. Modules
          outside the area run once: a cable from one into the area gives every voice the same signal, and one out of the area
          adds the voices up. Poly plays a note on voices of its own; Mono plays one note at a time, from the keys held.
        </p>
      </section>
      <VoiceSettings />

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
