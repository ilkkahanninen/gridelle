/**
 * Object classes Gridelle allows in exported patches.
 *
 * The Organelle M ships Pd 0.49 vanilla (OS 4.x) or 0.53 (OS 5.x) with no cyclone,
 * zexy or ELSE. The preview embeds a newer Pd, so an object that only exists there
 * would work in the editor and fail on the device. Everything listed here exists in
 * Pd 0.49 vanilla core; add to it only after checking the Pd release notes.
 *
 * Deliberately absent: `slop~`, `pdcontrol`, `file` (0.50+), the `extra` objects
 * (`bob~`, `sigmund~`, `rev1~`–`rev3~`), which may not be installed on OS 4.x.
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
  "tabread~", "tabwrite~", "table",
  // filters and delays
  "vcf~", "lop~", "hip~", "bp~", "biquad~", "rpole~", "rzero~", "cpole~", "czero~",
  "delwrite~", "delread~", "vd~", "samphold~",
  // analysis and routing
  "threshold~", "env~", "snapshot~", "throw~", "catch~", "send~", "s~", "receive~", "r~",
  // expr family (vanilla since 0.47; confirm on the device before modules rely on it)
  "expr", "expr~",
]);
