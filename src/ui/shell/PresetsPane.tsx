import { useEffect } from "react";
import { showPresetFolder } from "../../bridge/files";
import { NEW_PATCH_NAME } from "../../core/presets";
import { deletePreset, openPreset, savePatch } from "../../state/actions";
import { refreshPresets, usePresets } from "../../state/presets";
import { hasUnsavedChanges, useEditor } from "../../state/store";
import "./PresetsPane.css";

/**
 * The preset picker, for the side pane of that name: the presets in the presets folder,
 * the one that new patches start from first, where a click opens one; and under them
 * the patch's name, which is the name it is saved under, and the button that saves it.
 */
export function PresetsPane() {
  const name = useEditor((s) => s.doc.name);
  const filePath = useEditor((s) => s.filePath);
  const unsaved = useEditor(hasUnsavedChanges);
  const apply = useEditor((s) => s.apply);
  const saved = usePresets((s) => s.saved);
  // "New patch" first: it is where one starts. The rest as they are listed, by name.
  const presets = [...saved.filter((p) => p.name === NEW_PATCH_NAME), ...saved.filter((p) => p.name !== NEW_PATCH_NAME)];
  const problem = usePresets((s) => s.problem);

  // The list is of files: read it when the pane opens, and again when the window comes
  // back to the front, in case presets were copied in or out meanwhile.
  useEffect(() => {
    void refreshPresets();
    const onFocus = () => void refreshPresets();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <div className="presets-pane">
      <section>
        {problem ? (
          <p className="presets-problem">{problem}</p>
        ) : presets.length === 0 ? (
          <p>No presets yet. Save puts the patch here, in the Gridelle folder of your Documents.</p>
        ) : (
          <ul className="preset-list">
            {presets.map((preset) => {
              const open = preset.path === filePath;
              return (
                <li key={preset.path} className={open ? "preset-open" : undefined}>
                  <button className="preset" aria-current={open || undefined} title={preset.path} onClick={() => void openPreset(preset)}>
                    {preset.name}
                  </button>
                  <button
                    className="preset-delete"
                    title={`Delete ${preset.name}`}
                    aria-label={`Delete ${preset.name}`}
                    onClick={() => void deletePreset(preset)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!problem && (
          <button className="button button-danger presets-folder" onClick={() => void showPresetFolder()}>
            Show folder
          </button>
        )}
      </section>
      <section>
        <input
          id="preset-name"
          type="text"
          value={name}
          placeholder="Name"
          aria-label="Name"
          maxLength={40}
          spellCheck={false}
          onChange={(e) => apply((doc) => ({ ...doc, name: e.target.value }), "patch-name")}
          onKeyDown={(e) => {
            if (e.key === "Enter") void savePatch();
          }}
        />
        <button className="button button-primary" title="Save the patch as a preset, under this name (⌘S)" onClick={() => void savePatch()}>
          Save
        </button>
        {filePath && <p className={unsaved ? "presets-unsaved" : undefined}>{unsaved ? "Changed since it was saved." : "Saved."}</p>}
      </section>
    </div>
  );
}
