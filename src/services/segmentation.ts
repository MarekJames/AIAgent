import {
  TranscriptSegment,
  TranscriptWord,
  isSentenceBoundaryToken,
} from "./openai";
import { SceneChange } from "./ffmpeg";
import { Chapter } from "./youtube";

export interface Segment {
  startSec: number;
  endSec: number;
  durationSec: number;
  words: TranscriptWord[];
  text: string;
  hook: string;
  score: number;
  chapterTitle?: string;
}

function hasOverlap(a: Segment, b: Segment): boolean {
  if (a.endSec <= b.startSec) {
    return false;
  }
  if (b.endSec <= a.startSec) {
    return false;
  }
  return true;
}

function removeOverlaps(segments: Segment[]): Segment[] {
  if (segments.length === 0) {
    return [];
  }
  const sorted = [...segments].sort((x, y) => y.score - x.score);
  const out: Segment[] = [];
  for (const s of sorted) {
    let keep = true;
    for (const k of out) {
      if (hasOverlap(s, k)) {
        keep = false;
        break;
      }
    }
    if (keep) {
      out.push(s);
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

function chooseTargets(): number[] {
  return [60, 120];
}

function withinTolerance(d: number, target: number): boolean {
  const low = target - 15;
  const high = target + 15;
  if (d < low) {
    return false;
  }
  if (d > high) {
    return false;
  }
  return true;
}

function snapToBoundary(
  words: TranscriptWord[],
  startSec: number,
  hardEndSec: number,
  target: number
): { endSec: number; slice: TranscriptWord[] } {
  if (words.length === 0) {
    return { endSec: startSec, slice: [] };
  }
  const desired = startSec + target;
  const maxEnd = Math.min(hardEndSec, startSec + target + 15);
  const minEnd = Math.max(startSec + target - 15, startSec + 20);
  let idx = words.findIndex((w) => w.end >= desired);
  if (idx === -1) {
    idx = words.length - 1;
  }
  let pick = idx;
  for (let i = idx; i < words.length; i++) {
    const w = words[i];
    if (w.end > maxEnd) {
      break;
    }
    const tok = w.word;
    const next = words[i + 1];
    const gap = next ? next.start - w.end : 0;
    if (isSentenceBoundaryToken(tok)) {
      pick = i;
      break;
    }
    if (gap >= 0.8 && w.end >= minEnd) {
      pick = i;
      break;
    }
  }
  if (
    words[pick].end - startSec < 20 &&
    words[words.length - 1].end - startSec >= 20
  ) {
    while (pick < words.length - 1 && words[pick].end - startSec < 20) {
      pick = pick + 1;
    }
  }
  const endSec = Math.min(maxEnd, words[pick].end);
  const slice = words.filter((w) => w.end <= endSec + 1e-3);
  return { endSec, slice };
}

function scoreBasic(
  words: TranscriptWord[],
  start: number,
  end: number,
  sceneChanges: SceneChange[]
): number {
  const dur = Math.max(0.001, end - start);
  const speech = words.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);
  const pause = Math.max(0, dur - speech);
  const pauseRatio = pause / dur;
  const wps = words.length / dur;
  const hook = words
    .filter((w) => w.start - start < 3)
    .map((w) => w.word)
    .join(" ")
    .toLowerCase();
  const hookHits = [
    "how",
    "why",
    "what",
    "watch",
    "secret",
    "truth",
    "mistake",
    "biggest",
    "here's",
    "stop",
  ].reduce((n, k) => (hook.includes(k) ? n + 1 : n), 0);
  const scenes = sceneChanges.filter(
    (s) => s.timeSec >= start && s.timeSec <= end
  ).length;
  const pacing = Math.max(0, 1 - Math.abs(pauseRatio - 0.18));
  const variety = scenes >= 1 && scenes <= 6 ? 0.8 : 0.5;
  const hookness = Math.min(1, 0.4 + 0.1 * hookHits + (wps > 2.2 ? 0.1 : 0));
  const coh = end - start >= 20 ? 0.7 : 0.4;
  const base = 0.3 * hookness + 0.25 * pacing + 0.2 * variety + 0.25 * coh;
  return base;
}

export function detectSegments(
  transcript: TranscriptSegment[],
  sceneChanges: SceneChange[],
  chapters: Chapter[] = [],
  videoDuration: number = 0
): Segment[] {
  const all: TranscriptWord[] = [];
  for (const s of transcript) {
    for (const w of s.words) {
      all.push(w);
    }
  }
  if (all.length === 0) {
    return [];
  }
  const targets = chooseTargets();
  const limLow = Math.min(...targets) - 15;
  const limHigh = Math.max(...targets) + 15;
  const windows: Array<{ start: number; end: number; title: string }> = [];
  const stride = 45;
  const winLen = Math.min(limHigh + 10, 135);
  const endCap = Math.max(videoDuration, all[all.length - 1].end);
  for (let t = 0; t + limLow < endCap; t += stride) {
    const e = Math.min(endCap, t + winLen);
    windows.push({ start: t, end: e, title: "Window" });
  }
  const candidates: Segment[] = [];
  for (const win of windows) {
    const words = all.filter((w) => w.start >= win.start && w.start < win.end);
    if (words.length < 12) {
      continue;
    }
    const pauses: number[] = [0];
    for (let i = 0; i < words.length - 1; i++) {
      const gap = words[i + 1].start - words[i].end;
      if (gap >= 0.35 && gap <= 1.2) {
        pauses.push(i + 1);
      }
    }
    pauses.push(words.length);
    for (let i = 0; i < pauses.length - 1; i++) {
      for (let j = i + 1; j < pauses.length; j++) {
        const segWords = words.slice(pauses[i], pauses[j]);
        if (segWords.length < 10) {
          continue;
        }
        const s = segWords[0].start;
        const hardEnd = segWords[segWords.length - 1].end;
        for (const t of targets) {
          const { endSec, slice } = snapToBoundary(segWords, s, hardEnd, t);
          const d = endSec - s;
          if (!withinTolerance(d, t)) {
            continue;
          }
          const score = scoreBasic(slice, s, endSec, sceneChanges);
          const text = slice.map((w) => w.word).join(" ");
          const hook = slice
            .filter((w) => w.start - s < 3)
            .map((w) => w.word)
            .join(" ")
            .trim();
          candidates.push({
            startSec: s,
            endSec,
            durationSec: d,
            words: slice,
            text,
            hook: hook || text.substring(0, 60),
            score,
            chapterTitle: win.title,
          });
        }
      }
    }
  }
  const filtered = candidates.filter(
    (c) => c.durationSec >= 45 && c.durationSec <= 135
  );
  filtered.sort((a, b) => b.score - a.score);
  const unique = removeOverlaps(filtered);
  return unique.slice(0, 12);
}
