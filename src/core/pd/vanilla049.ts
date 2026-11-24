/**
 * Object classes Gridelle allows in exported patches.
 *
 * The Organelle M ships Pd 0.49 vanilla (OS 4.x) or 0.53 (OS 5.x) with no cyclone,
 * zexy or ELSE. The preview embeds a newer Pd, so an object that only exists there
 * would work in the editor and fail on the device. Everything listed here exists in
 * Pd 0.49 vanilla core; add to it only after checking the Pd release notes.
 *
 * Deliberately absent: `slop~`, `pdcontrol`, `file` (0.50+). The objects from Pd's
 * `extra` folder that modules may use are listed separately, in `PD_EXTRA_049`.
 */
export const VANILLA_049_OBJECTS: ReadonlySet<string> = new Set([
  // structure
  "inlet", "outlet", "inlet~", "outlet~", "clone", "loadbang", "switch~", "block~", "samplerate~",
  // messages
  "r", "receive", "s", "send", "f", "float", "i", "int", "t", "trigger", "b", "bang",
  "pack", "unpack", "route", "sel", "select", "spigot", "moses", "change", "swap",
  "poly", "until", "del", "delay", "metro", "timer", "random", "symbol", "list",
  "makefilename", "pipe", "line", "clip", "max", "min",
  // control arithmetic
  "+", "-", "*", "/", "pow", "mod", "div", ">", "<", ">=", "<=", "==", "!=", "&&", "||",
  "mtof", "ftom", "dbtorms", "rmstodb", "abs", "sqrt", "exp", "log", "sin", "cos",
  // signal arithmetic
  "+~", "-~", "*~", "/~", "max~", "min~", "clip~", "abs~", "sqrt~", "wrap~", "pow~",
  "exp~", "log~", "mtof~", "ftom~", "dbtorms~", "rmstodb~", "cos~",
  // signal sources and control-to-signal
  "sig~", "line~", "vline~", "phasor~", "osc~", "noise~", "tabosc4~", "tabread4~",
  "tabread~", "tabwrite~", "table", "soundfiler", "bang~",
  // control-rate table access: older than "array", which 0.45 brought as their replacement
  "tabread", "tabwrite",
  // filters and delays
  "vcf~", "lop~", "hip~", "bp~", "biquad~", "rpole~", "rzero~", "cpole~", "czero~", "rzero_rev~",
  "delwrite~", "delread~", "vd~", "samphold~",
  // analysis and routing
  "threshold~", "env~", "snapshot~", "throw~", "catch~", "send~", "s~", "receive~", "r~",
  // expr family (vanilla since 0.47; confirm on the device before modules rely on it)
  "expr", "expr~",
]);

/**
 * Objects from Pd's `extra` folder that modules wrap: an external (`bob~`) and
 * abstractions (the reverbs). They are part of Pd's installation on the Organelle and
 * were in `extra` in Pd 0.49, so an exported patch names them and does not carry them.
 * The preview's own Pd gets them from `src-tauri`: `build.rs` compiles the external and
 * `engine/pd.rs` puts the abstractions on the search path. Adding one here needs both.
 */
export const PD_EXTRA_049: ReadonlySet<string> = new Set(["bob~", "rev1~", "rev2~", "rev3~"]);

/** Whether an object class is one of Pd's own, in the core or in `extra`. */
export const isPdObject = (name: string) => VANILLA_049_OBJECTS.has(name) || PD_EXTRA_049.has(name);
