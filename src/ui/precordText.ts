import type { VoiceSignal } from "../core/modules/types";

/**
 * What an input with a pre-cord follows, in words: in the voice area the voice's own note,
 * outside it the keyboard as one part (`ge-keyboard`).
 */
export function precordText(signal: VoiceSignal, inVoices: boolean): string {
  if (inVoices) return { pitch: "the played note", gate: "the key gate", velocity: "key velocity", unison: "the voice's place in its Unison" }[signal];
  return { pitch: "the last key", gate: "any key held", velocity: "the last key's velocity", unison: "the middle of a Unison" }[signal];
}
