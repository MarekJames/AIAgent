import {
  TranscriptSegment,
  TranscriptWord,
  isSentenceBoundaryToken,
} from "./openai";
import { SceneChange } from "./ffmpeg";
import { Chapter } from "./youtube";

export interface EnhancedSegment {
  startSec: number;
  endSec: number;
  durationSec: number;
  words: TranscriptWord[];
  text: string;
  hook: string;
  score: number;
  features: SegmentFeatures;
  rationaleShort: string;
  durationChoice: "t60" | "t120";
  chapterTitle?: string;
}

export interface SegmentFeatures {
  hookScore: number;
  retentionScore: number;
  clarityScore: number;
  visualScore: number;
  noveltyScore: number;
  engagementScore: number;
  safetyScore: number;
  speechRate: number;
  pauseDensity: number;
  energyLevel: number;
  hasQuestion: boolean;
  hasBoldClaim: boolean;
  hasNumbers: boolean;
  sceneChangeCount: number;
  wordCount: number;
  coherenceScore: number;
  closureScore: number;
  arcScore: number;
  semanticDensity: number;
}

export interface CommentHotspot {
  timeSec: number;
  density: number;
}

export function mineTimestampsFromComments(
  comments: { text: string }[]
): number[] {
  const ts = /(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/g;
  const marks: number[] = [];
  for (const c of comments) {
    const m = c.text.matchAll(ts);
    for (const x of m) {
      const h = x[3] ? parseInt(x[1], 10) : 0;
      const mm = x[3] ? parseInt(x[2], 10) : parseInt(x[1], 10);
      const ss = x[3] ? parseInt(x[3], 10) : parseInt(x[2], 10);
      const sec = h * 3600 + mm * 60 + ss;
      marks.push(sec);
    }
  }
  return clusterPeaks(marks, 30);
}

function clusterPeaks(xs: number[], windowSec: number): number[] {
  if (xs.length === 0) {
    return [];
  }
  const s = [...xs].sort((a, b) => a - b);
  const peaks: number[] = [];
  let acc: number[] = [];
  for (const x of s) {
    if (acc.length === 0) {
      acc.push(x);
    } else {
      const last = acc[acc.length - 1];
      if (x - last <= windowSec) {
        acc.push(x);
      } else {
        peaks.push(median(acc));
        acc = [x];
      }
    }
  }
  if (acc.length > 0) {
    peaks.push(median(acc));
  }
  return peaks;
}

function median(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2);
}

export function generateChapterWindows(
  chapters: Chapter[],
  introIdx: number | null
): Array<{ start: number; end: number; chapterTitle: string }> {
  const ws: Array<{ start: number; end: number; chapterTitle: string }> = [];
  for (let i = 0; i < chapters.length; i++) {
    if (introIdx !== null && i === introIdx) {
      continue;
    }
    const c = chapters[i];
    const span = Math.max(0, c.endSec - c.startSec);
    const step = Math.max(50, Math.floor(span * 0.12));
    let t = c.startSec;
    const chapterWindows: Array<{
      start: number;
      end: number;
      chapterTitle: string;
    }> = [];
    while (t + 45 <= c.endSec) {
      const end = Math.min(c.endSec, t + 135);
      chapterWindows.push({ start: t, end, chapterTitle: c.title });
      t += step;
    }
    if (chapterWindows.length === 0) {
      chapterWindows.push({
        start: c.startSec,
        end: Math.min(c.endSec, c.startSec + Math.min(135, span || 135)),
        chapterTitle: c.title,
      });
    } else {
      const last = chapterWindows[chapterWindows.length - 1];
      if (last.end < c.endSec - 8) {
        const tailStart = Math.max(c.startSec, c.endSec - 135);
        if (chapterWindows[chapterWindows.length - 1].start !== tailStart) {
          chapterWindows.push({
            start: tailStart,
            end: c.endSec,
            chapterTitle: c.title,
          });
        }
      }
    }
    ws.push(...chapterWindows);
  }
  return ws;
}

function generateFullCoverageWindows(
  allWords: TranscriptWord[],
  videoDuration: number
): Array<{ start: number; end: number; chapterTitle: string }> {
  const lastEnd = allWords.length > 0 ? allWords[allWords.length - 1].end : 0;
  const coverageEnd = Math.max(videoDuration, lastEnd);
  if (coverageEnd <= 0) {
    return [];
  }
  const windows: Array<{ start: number; end: number; chapterTitle: string }> =
    [];
  const stride = coverageEnd > 1800 ? 90 : 65;
  const winLen = 135;
  for (let start = 0; start < coverageEnd; start += stride) {
    const end = Math.min(coverageEnd, start + winLen);
    windows.push({ start, end, chapterTitle: "Full Video" });
  }
  if (windows.length === 0) {
    windows.push({ start: 0, end: coverageEnd, chapterTitle: "Full Video" });
  } else {
    const last = windows[windows.length - 1];
    if (last.end < coverageEnd - 5) {
      const tailStart = Math.max(0, coverageEnd - winLen);
      if (windows[windows.length - 1].start !== tailStart) {
        windows.push({
          start: tailStart,
          end: coverageEnd,
          chapterTitle: "Full Video",
        });
      } else {
        windows[windows.length - 1] = {
          start: tailStart,
          end: coverageEnd,
          chapterTitle: "Full Video",
        };
      }
    }
  }
  return windows;
}

function detectHookPatterns(text: string): {
  hasQuestion: boolean;
  hasBoldClaim: boolean;
  hasNumbers: boolean;
} {
  const hasQuestion =
    /^(how|what|why|when|where|who|can|will|should|is|are|do|does|did)\s/i.test(
      text
    ) || /\?/.test(text);
  const bold = [
    /^(this is|here's|the best|the worst|never|always|you need|you must|don't|stop)/i,
    /^(secret|truth|fact|proven|guaranteed|ultimate|perfect)/i,
    /(vs\.|versus|vs|compared to)/i,
    /^(shocking|amazing|incredible|unbelievable)/i,
  ];
  const hasBoldClaim = bold.some((p) => p.test(text));
  const hasNumbers = /\b\d+\b/.test(text);
  return { hasQuestion, hasBoldClaim, hasNumbers };
}

function analyzeSpeechDynamics(
  words: TranscriptWord[],
  start: number
): { rate: number; pauseDensity: number; energy: number } {
  if (words.length === 0) {
    return { rate: 0, pauseDensity: 1, energy: 0 };
  }
  const w = words.filter((x) => x.start - start < 5);
  if (w.length === 0) {
    return { rate: 0, pauseDensity: 1, energy: 0 };
  }
  const dur = Math.max(0.1, w[w.length - 1].end - w[0].start);
  const rate = w.length / dur;
  let gap = 0;
  for (let i = 0; i < w.length - 1; i++) {
    gap = gap + Math.max(0, w[i + 1].start - w[i].end);
  }
  const pauseDensity = gap / dur;
  const energy =
    w.filter(
      (x) =>
        /[A-Z]{2,}/.test(x.word) || /[!?]/.test(x.word) || x.word.length > 8
    ).length / w.length;
  return { rate, pauseDensity, energy };
}

const STOP = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "with",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

function calcFeatures(
  words: TranscriptWord[],
  start: number,
  end: number,
  scenes: SceneChange[],
  hotspots: number[]
): SegmentFeatures {
  const text = words.map((w) => w.word).join(" ");
  const hookText = words
    .filter((w) => w.start - start < 3)
    .map((w) => w.word)
    .join(" ")
    .trim();
  const lower = words.map((w) => w.word.toLowerCase());
  const clean = lower.map((w) => w.replace(/[^a-z0-9']/gi, ""));
  const content = clean.filter((w) => w.length > 2 && !STOP.has(w));
  const semanticDensity = Math.min(
    1,
    content.length / Math.max(1, words.length)
  );
  const hp = detectHookPatterns(hookText || text.substring(0, 100));
  const dyn = analyzeSpeechDynamics(words, start);
  const sc = scenes.filter(
    (s) => s.timeSec >= start && s.timeSec <= end
  ).length;
  let hookScore = 0.5;
  if (hp.hasQuestion) {
    hookScore = hookScore + 0.2;
  }
  if (hp.hasBoldClaim) {
    hookScore = hookScore + 0.2;
  }
  if (hp.hasNumbers) {
    hookScore = hookScore + 0.1;
  }
  if (dyn.energy > 0.3) {
    hookScore = hookScore + 0.15;
  }
  if (dyn.rate > 2.5) {
    hookScore = hookScore + 0.1;
  }
  if (hookScore > 1) {
    hookScore = 1;
  }
  let retentionScore = 0.5;
  if (dyn.rate > 2) {
    retentionScore = retentionScore + 0.2;
  }
  if (dyn.pauseDensity < 0.2) {
    retentionScore = retentionScore + 0.15;
  }
  if (sc >= 2 && sc <= 4) {
    retentionScore = retentionScore + 0.15;
  }
  if (retentionScore > 1) {
    retentionScore = 1;
  }
  const filler = words.filter((w) =>
    /^(um|uh|like|you know|sort of|kind of)$/i.test(w.word.trim())
  ).length;
  const fillerRatio = filler / Math.max(1, words.length);
  const clarityScore = Math.max(0, 1 - 2 * fillerRatio);
  const visualScore = sc >= 1 && sc <= 6 ? 0.8 : 0.5;
  const noveltyScore = 0.6;
  const nearHot = hotspots.some((h) => Math.abs(h - start) < 30);
  const engagementScore = nearHot ? 0.8 : 0.4;
  const bad = /\b(fuck|shit|damn|hell|ass|bitch)\b/i.test(text);
  const safetyScore = bad ? 0.3 : 0.9;
  const sentEnd = text.match(/[.!?]/g)?.length ?? 0;
  const sent = Math.max(1, sentEnd || Math.ceil((end - start) / 7));
  const avgWps = words.length / sent;
  let coherenceScore = 0.55;
  if (avgWps >= 8 && avgWps <= 28) {
    coherenceScore = coherenceScore + 0.2;
  }
  if (semanticDensity > 0.55) {
    coherenceScore = coherenceScore + 0.15;
  }
  if (fillerRatio < 0.12) {
    coherenceScore = coherenceScore + 0.1;
  }
  if (clarityScore > 0.75) {
    coherenceScore = coherenceScore + 0.05;
  }
  if (coherenceScore > 1) {
    coherenceScore = 1;
  }
  if (coherenceScore < 0.3) {
    coherenceScore = 0.3;
  }
  const closeWin = words.filter((w) => end - w.end < 4);
  const closeText = closeWin.map((w) => w.word.toLowerCase()).join(" ");
  const last =
    closeWin[closeWin.length - 1]?.word ?? words[words.length - 1]?.word ?? "";
  const hardStop = isSentenceBoundaryToken(last);
  const closurePhrases = [
    "that's why",
    "so you can",
    "and that's",
    "that's how",
    "in the end",
    "the point is",
  ];
  const trailingFill = /(um|uh|like)$/i.test(last?.trim?.() || "");
  let closureScore = 0.45;
  if (hardStop) {
    closureScore = closureScore + 0.25;
  }
  if (closurePhrases.some((p) => closeText.includes(p))) {
    closureScore = closureScore + 0.15;
  }
  if (
    closeWin.length > 0 &&
    closeWin.some((w) => /\bso\b|\btherefore\b|\bmeaning\b/i.test(w.word))
  ) {
    closureScore = closureScore + 0.1;
  }
  if (trailingFill) {
    closureScore = closureScore - 0.15;
  }
  if (closureScore > 1) {
    closureScore = 1;
  }
  if (closureScore < 0.2) {
    closureScore = 0.2;
  }
  const resolution = [
    "because",
    "so",
    "that's why",
    "that means",
    "which means",
    "therefore",
    "result",
    "here's",
  ];
  const payoff = [
    "so you can",
    "that's how",
    "in the end",
    "the reason",
    "the secret",
    "so the",
    "what happens",
  ];
  const lt = text.toLowerCase();
  const hasRes = resolution.some((k) => lt.includes(k));
  const hasPay = payoff.some((k) => lt.includes(k));
  const earlyQ = words
    .filter((w) => w.start - start < 6)
    .some(
      (w) =>
        /\?$/.test(w.word) ||
        /^(how|why|what|when|where|who|can|should|would)\b/i.test(w.word)
    );
  let arcScore = 0.45;
  if (hp.hasQuestion || earlyQ) {
    arcScore = arcScore + 0.2;
  }
  if (hasRes) {
    arcScore = arcScore + 0.2;
  }
  if (hasPay) {
    arcScore = arcScore + 0.1;
  }
  if (closureScore > 0.7) {
    arcScore = arcScore + 0.05;
  }
  if (arcScore > 1) {
    arcScore = 1;
  }
  if (arcScore < 0.25) {
    arcScore = 0.25;
  }
  return {
    hookScore,
    retentionScore,
    clarityScore,
    visualScore,
    noveltyScore,
    engagementScore,
    safetyScore,
    speechRate: dyn.rate,
    pauseDensity: dyn.pauseDensity,
    energyLevel: dyn.energy,
    hasQuestion: hp.hasQuestion,
    hasBoldClaim: hp.hasBoldClaim,
    hasNumbers: hp.hasNumbers,
    sceneChangeCount: sc,
    wordCount: words.length,
    coherenceScore,
    closureScore,
    arcScore,
    semanticDensity,
  };
}

function scoreSegment(f: SegmentFeatures): number {
  return (
    0.24 * f.hookScore +
    0.18 * f.retentionScore +
    0.12 * f.clarityScore +
    0.1 * f.coherenceScore +
    0.1 * f.closureScore +
    0.08 * f.arcScore +
    0.08 * f.engagementScore +
    0.05 * f.noveltyScore +
    0.03 * f.visualScore +
    0.02 * f.safetyScore
  );
}

function chooseDuration(
  targets: number[],
  candidate: number,
  f: SegmentFeatures
): { target: number; choice: "t60" | "t120" } {
  const t60 = 60;
  const t120 = 120;
  const can120 = candidate >= 105;
  const longSignals =
    (f.retentionScore + f.closureScore + f.arcScore) / 3 > 0.68 &&
    f.coherenceScore > 0.65 &&
    f.semanticDensity > 0.55;
  let pick = t60;
  if (can120 && longSignals) {
    pick = t120;
  }
  const choice: "t60" | "t120" = pick === 120 ? "t120" : "t60";
  return { target: pick, choice };
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

function adjustToBoundary(
  words: TranscriptWord[],
  start: number,
  hardEnd: number,
  target: number
): { slice: TranscriptWord[]; end: number } {
  if (words.length === 0) {
    return { slice: [], end: start };
  }
  const desired = start + target;
  const maxEnd = Math.min(hardEnd, start + target + 15);
  const minEnd = Math.max(start + target - 15, start + 20);
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
    words[pick].end - start < 20 &&
    words[words.length - 1].end - start >= 20
  ) {
    while (pick < words.length - 1 && words[pick].end - start < 20) {
      pick = pick + 1;
    }
  }
  const end = Math.min(maxEnd, words[pick].end);
  const slice = words.filter((w) => w.end <= end + 1e-3);
  return { slice, end };
}

function qualityGuards(s: EnhancedSegment): boolean {
  const first3 = s.words.filter((w) => w.start - s.startSec < 3);
  if (first3.length < 3) {
    return false;
  }
  if (s.features.safetyScore < 0.5) {
    return false;
  }
  if (s.features.clarityScore < 0.3) {
    return false;
  }
  if (s.features.coherenceScore < 0.45) {
    return false;
  }
  if (s.features.closureScore < 0.4) {
    return false;
  }
  return true;
}

function jaccard(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/));
  const sb = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const w of sa) {
    if (sb.has(w)) {
      inter = inter + 1;
    }
  }
  const uni = sa.size + sb.size - inter;
  if (uni === 0) {
    return 0;
  }
  return inter / uni;
}

function diversify(xs: EnhancedSegment[], thr: number): EnhancedSegment[] {
  if (xs.length === 0) {
    return [];
  }
  const s = [...xs].sort((a, b) => b.score - a.score);
  const out: EnhancedSegment[] = [s[0]];
  for (let i = 1; i < s.length; i++) {
    let ok = true;
    for (const e of out) {
      if (jaccard(s[i].text, e.text) > thr) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push(s[i]);
    }
  }
  return out;
}

function removeOverlaps(segments: EnhancedSegment[]): EnhancedSegment[] {
  if (segments.length === 0) {
    return [];
  }
  const sorted = [...segments].sort((a, b) => b.score - a.score);
  const out: EnhancedSegment[] = [];
  for (const s of sorted) {
    let overlaps = false;
    for (const e of out) {
      if (!(s.endSec <= e.startSec || e.endSec <= s.startSec)) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      out.push(s);
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

function rationale(f: SegmentFeatures, score: number): string {
  const rs: Array<{ t: string; v: number }> = [];
  if (f.hookScore > 0.7) {
    rs.push({ t: "strong hook", v: f.hookScore });
  }
  if (f.retentionScore > 0.7) {
    rs.push({ t: "high retention", v: f.retentionScore });
  }
  if (f.clarityScore > 0.8) {
    rs.push({ t: "clear message", v: f.clarityScore });
  }
  if (f.engagementScore > 0.7) {
    rs.push({ t: "audience hotspot", v: f.engagementScore });
  }
  if (f.coherenceScore > 0.7) {
    rs.push({ t: "coherent flow", v: f.coherenceScore });
  }
  if (f.closureScore > 0.65) {
    rs.push({ t: "satisfying payoff", v: f.closureScore });
  }
  if (f.arcScore > 0.65) {
    rs.push({ t: "question→answer arc", v: f.arcScore });
  }
  if (f.hasQuestion) {
    rs.push({ t: "question hook", v: 0.8 });
  }
  if (f.hasBoldClaim) {
    rs.push({ t: "bold claim", v: 0.75 });
  }
  if (f.sceneChangeCount >= 2 && f.sceneChangeCount <= 4) {
    rs.push({ t: "good visual pacing", v: 0.7 });
  }
  const top = rs
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => x.t);
  if (top.length === 0) {
    return `Segment scored ${(score * 100).toFixed(0)}/100`;
  }
  return `Strong because: ${top.join(", ")}`;
}

function findIntroChapterIndex(
  chapters: Chapter[],
  detectedLanguage?: string
): number | null {
  if (chapters.length === 0) {
    return null;
  }
  const map: Record<string, string[]> = {
    en: ["intro", "introduction", "opening", "welcome"],
    es: ["intro", "introduccion", "introducción", "apertura", "inicio"],
    pt: ["intro", "introducao", "introdução", "apresentação", "abertura"],
    fr: ["intro", "introduction", "ouverture"],
    de: ["intro", "einführung", "einleitung"],
  };
  const keys =
    detectedLanguage && map[detectedLanguage]
      ? map[detectedLanguage]
      : Object.values(map).flat();
  const t = chapters[0].title.toLowerCase();
  for (const k of keys) {
    if (t.includes(k)) {
      return 0;
    }
  }
  return null;
}

export function detectEnhancedSegments(
  transcript: TranscriptSegment[],
  sceneChanges: SceneChange[],
  chapters: Chapter[],
  videoDuration: number,
  commentHotspots: number[] = []
): EnhancedSegment[] {
  const all: TranscriptWord[] = [];
  for (const s of transcript) {
    for (const w of s.words) {
      all.push(w);
    }
  }
  if (all.length === 0) {
    return [];
  }
  const lang = transcript[0]?.language;
  const introIdx = findIntroChapterIndex(chapters, lang);
  let windows =
    chapters.length > 0
      ? generateChapterWindows(chapters, introIdx)
      : generateFullCoverageWindows(all, videoDuration);
  if (chapters.length > 0) {
    const fb = generateFullCoverageWindows(all, videoDuration);
    const maxEnd = windows.reduce((m, w) => Math.max(m, w.end), 0);
    const covEnd = fb.length > 0 ? fb[fb.length - 1].end : maxEnd;
    if (covEnd > maxEnd + 5) {
      windows = windows.concat(fb.filter((w) => w.start >= maxEnd - 60));
    }
  }
  windows = windows
    .sort((a, b) => a.start - b.start)
    .filter(
      (w, i, arr) =>
        i === 0 || w.start !== arr[i - 1].start || w.end !== arr[i - 1].end
    );
  const targets = [60, 120];
  const cands: EnhancedSegment[] = [];
  for (const win of windows) {
    const ww = all.filter((w) => w.start >= win.start && w.start < win.end);
    if (ww.length < 12) {
      continue;
    }
    const cuts: number[] = [0];
    for (let i = 0; i < ww.length - 1; i++) {
      const g = ww[i + 1].start - ww[i].end;
      if (g >= 0.35 && g <= 1.2) {
        cuts.push(i + 1);
      }
    }
    cuts.push(ww.length);
    for (let i = 0; i < cuts.length - 1; i++) {
      for (let j = i + 1; j < cuts.length; j++) {
        const seg = ww.slice(cuts[i], cuts[j]);
        if (seg.length < 12) {
          continue;
        }
        const s = seg[0].start;
        const hardEnd = seg[seg.length - 1].end;
        const prelimF = calcFeatures(
          seg,
          s,
          hardEnd,
          sceneChanges,
          commentHotspots
        );
        const prelimScore = scoreSegment(prelimF);
        if (prelimScore < 0.5) {
          continue;
        }
        const pick = chooseDuration(targets, hardEnd - s, prelimF);
        const adj = adjustToBoundary(seg, s, hardEnd, pick.target);
        const d = adj.end - s;
        if (!withinTolerance(d, pick.target)) {
          continue;
        }
        if (adj.slice.length < 12) {
          continue;
        }
        const finalF = calcFeatures(
          adj.slice,
          s,
          adj.end,
          sceneChanges,
          commentHotspots
        );
        const finalScore = scoreSegment(finalF);
        if (finalScore < 0.52) {
          continue;
        }
        const text = adj.slice.map((w) => w.word).join(" ");
        const hook = adj.slice
          .filter((w) => w.start - s < 3)
          .map((w) => w.word)
          .join(" ")
          .trim();
        const r = rationale(finalF, finalScore);
        cands.push({
          startSec: s,
          endSec: adj.end,
          durationSec: d,
          words: adj.slice,
          text,
          hook: hook || text.substring(0, 60),
          score: finalScore,
          features: finalF,
          rationaleShort: r,
          durationChoice: pick.choice,
          chapterTitle: win.chapterTitle,
        });
      }
    }
  }
  const guarded = cands.filter(qualityGuards);
  const diversified = diversify(guarded, 0.7);
  const nonOverlap = removeOverlaps(diversified);
  return nonOverlap.slice(0, 12);
}
