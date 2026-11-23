import { newPatch, openPatch, savePatch } from "../../state/actions";
import { hasUnsavedChanges, useEditor } from "../../state/store";
import "./PatchesPane.css";

/** The last part of a path, and what comes before it, whichever way its slashes lean. */
function split(path: string): [string, string] {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return [path.slice(at + 1), path.slice(0, at)];
}

/**
 * The patch as a file, for the side pane of that name: where it is saved, whether it has
 * changed since, and the buttons that start, open and save patches.
 */
export function PatchesPane() {
  const name = useEditor((s) => s.doc.name);
  const filePath = useEditor((s) => s.filePath);
  const unsaved = useEditor(hasUnsavedChanges);
  const [file, folder] = filePath ? split(filePath) : ["", ""];

  return (
    <div className="patches-pane">
      <section>
        <h3>{name || "Untitled"}</h3>
        {filePath ? (
          <>
            <p className="patches-file" title={filePath}>
              <span>{file}</span>
              <span className="patches-folder">{folder}</span>
            </p>
            <p className={unsaved ? "patches-unsaved" : undefined}>{unsaved ? "Changed since it was saved." : "Saved."}</p>
          </>
        ) : (
          <p>Not saved yet.</p>
        )}
        <button className="button button-primary" title="Save the patch (⌘S)" onClick={() => void savePatch()}>
          Save
        </button>
        <button className="button" title="Save the patch in another file (⇧⌘S)" onClick={() => void savePatch(true)}>
          Save as…
        </button>
      </section>
      <section>
        <button className="button" title="Open a patch (⌘O)" onClick={() => void openPatch()}>
          Open…
        </button>
        <button className="button" title="Start an empty patch (⌘N)" onClick={() => void newPatch()}>
          New patch
        </button>
      </section>
    </div>
  );
}
