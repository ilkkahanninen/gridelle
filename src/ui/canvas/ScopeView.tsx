import { useEffect, useRef } from "react";
import { engine } from "../../bridge/engine";
import * as ops from "../../core/model/ops";
import type { ModuleInstance } from "../../core/model/types";
import { SCOPE_RANGES, SCOPE_TIMES } from "../../core/modules/registry";
import { usePreview } from "../../state/preview";

/** Pictures a second. The audio is not affected by how often the picture is asked for. */
const FRAME_MS = 33;
/** Up to this width a wave is held still by triggering; a slower picture rolls. */
const TRIGGER_UP_TO_MS = 100;

/** A number for the corner of the picture: three figures, no trailing zeros. */
const label = (value: number) => String(Number(value.toPrecision(3)));

/**
 * The picture on a Scope tile: what the module's input carries in the preview. The engine
 * hands over the latest stretch as a lowest and a highest value for each column, and this
 * draws a line through them about thirty times a second.
 */
export function ScopeView({ module }: { module: ModuleInstance }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The scope's number in the loaded patch, from 1; 0 while it has none.
  const number = usePreview((s) => s.scopes[module.id] ?? 0);
  const sampleRate = usePreview((s) => (s.engine.kind === "ready" ? s.engine.sampleRate : 0));
  const time = SCOPE_TIMES[ops.paramValue(module, "time")] ?? SCOPE_TIMES[0];
  // Half the height of the picture in signal units, or null to fit what is there.
  const range = SCOPE_RANGES[ops.paramValue(module, "range") - 1] ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const style = getComputedStyle(canvas);
    const colour = (name: string) => style.getPropertyValue(name).trim();
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.scale(ratio, ratio);
    context.font = `10px ${colour("--mono") || "monospace"}`;

    // What a fitted picture spans. It widens at once and narrows slowly, so that it does not twitch.
    let fitted: [number, number] | null = null;

    const draw = (picture: number[], note = "") => {
      context.clearRect(0, 0, width, height);
      let [bottom, top] = range === null ? [-1, 1] : [-range, range];
      // The numbers in the corners: the edges of a fixed picture, the extremes of a fitted one.
      let [least, most] = [bottom, top];
      if (range === null && picture.length > 0) {
        const low = Math.min(...picture);
        const high = Math.max(...picture);
        [least, most] = [low, high];
        // A flat line gets room around it in proportion to its size.
        const margin = Math.max((high - low) * 0.1, Math.abs(high) * 0.05, 0.01);
        const wanted: [number, number] = [low - margin, high + margin];
        fitted = fitted
          ? [Math.min(wanted[0], fitted[0] + (wanted[0] - fitted[0]) * 0.1), Math.max(wanted[1], fitted[1] + (wanted[1] - fitted[1]) * 0.1)]
          : wanted;
        [bottom, top] = fitted;
      }
      const y = (value: number) => height - ((value - bottom) / (top - bottom)) * height;

      // Zero, when it is in the picture.
      if (bottom < 0 && top > 0) {
        context.strokeStyle = colour("--line-strong");
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(0, Math.round(y(0)) + 0.5);
        context.lineTo(width, Math.round(y(0)) + 0.5);
        context.stroke();
      }

      // The wave: down and up through the lowest and highest of each column.
      const columns = picture.length / 2;
      if (columns > 0) {
        context.strokeStyle = colour("--text");
        context.lineWidth = 1.5;
        context.lineJoin = "round";
        context.beginPath();
        for (let column = 0; column < columns; column++) {
          const x = columns === 1 ? width / 2 : (column / (columns - 1)) * width;
          const [low, high] = [picture[column * 2], picture[column * 2 + 1]];
          // Whichever end is nearer to where the line was comes first.
          const first = column > 0 && Math.abs(picture[column * 2 - 1] - high) < Math.abs(picture[column * 2 - 1] - low) ? high : low;
          if (column === 0) context.moveTo(x, y(first));
          else context.lineTo(x, y(first));
          context.lineTo(x, y(first === low ? high : low));
        }
        context.stroke();
      }

      // Text in the right-hand corners, on a patch of the background so the wave does not cross it.
      context.textAlign = "right";
      const write = (text: string, baseline: "top" | "middle" | "bottom", at: number) => {
        const across = context.measureText(text).width + 6;
        const down = baseline === "top" ? at : baseline === "bottom" ? at - 13 : at - 6.5;
        context.fillStyle = colour("--surface");
        context.globalAlpha = 0.8;
        context.fillRect(width - across, down, across, 13);
        context.globalAlpha = 1;
        context.fillStyle = colour("--text-dim");
        context.textBaseline = baseline;
        context.fillText(text, width - 3, baseline === "top" ? at + 2 : baseline === "bottom" ? at - 1 : at);
      };
      if (note) {
        write(note, "middle", height / 2);
      } else {
        write(label(most), "top", 0);
        write(label(least), "bottom", height);
      }
    };

    if (!sampleRate) {
      draw([], "No audio preview");
      return;
    }
    if (!number) {
      draw([], "Not drawn");
      return;
    }

    let stopped = false;
    let waiting = false;
    let last = 0;
    let frame = requestAnimationFrame(function tick(now: number) {
      if (stopped) return;
      frame = requestAnimationFrame(tick);
      if (waiting || now - last < FRAME_MS) return;
      last = now;
      waiting = true;
      const length = Math.max(2, Math.round((time / 1000) * sampleRate));
      engine
        .scope(number - 1, length, Math.round(width), time <= TRIGGER_UP_TO_MS)
        .then((picture) => !stopped && draw(picture))
        .catch(() => {})
        .finally(() => (waiting = false));
    });
    draw([]);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [number, sampleRate, time, range]);

  return <canvas ref={canvasRef} className="tile-scope" aria-label="Scope picture" />;
}
