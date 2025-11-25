import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import * as fs from "fs/promises";
import path from "path";

//gpt
import os from "os";

const ffmpegPath = ffmpegStatic;
const ffprobePath = ffprobeStatic.path;

interface Probe {
  width: number;
  height: number;
  fps: number;
}

function run(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
      }
      if (code !== 0) {
        reject(new Error(err || out));
      }
    });
  });
}

export async function probeVideo(file: string): Promise<Probe> {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,avg_frame_rate",
    "-of",
    "json",
    file,
  ];
  const { stdout } = await run(ffprobePath, args);
  const j = JSON.parse(stdout);
  const s = j.streams[0];
  const fpsParts = String(s.avg_frame_rate || "0/1").split("/");
  const fps = Number(
    fpsParts[1] === "0" ? 0 : Number(fpsParts[0]) / Number(fpsParts[1]),
  );
  return { width: Number(s.width), height: Number(s.height), fps };
}

function even(n: number): number {
  if (n % 2 === 0) {
    return n;
  }
  return n - 1;
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function escapeSubtitlesPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function chooseTargetSize(
  srcW: number,
  srcH: number,
): { w: number; h: number } {
  let h = srcH;
  if (h > 1920) {
    h = 1920;
  }
  const w = even(Math.round((h * 9) / 16));
  return { w, h: even(h) };
}

function buildFilters(targetW: number, targetH: number): string {
  const scaleW = "'if(gt(iw/ih,0.5625),-2," + targetW + ")'";
  const scaleH = "'if(gt(iw/ih,0.5625)," + targetH + ",-2)'";
  const chain = [
    "scale=" + scaleW + ":" + scaleH,
    "crop=" + targetW + ":" + targetH + ":(in_w-out_w)/2:(in_h-out_h)/2",
    "format=yuv420p",
  ];
  return chain.join(",");
}

//gpt
async function writeFilterScript(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ffvf-"));
  const p = path.join(dir, "filtergraph.txt");
  await fs.writeFile(p, content, "utf8");
  return p;
}
// Keep coords in-bounds and even (ffmpeg requires even chroma sizes)
function clampExpr(expr: string, limitExpr: string): string {
  // floor(.../2)*2 snaps to even; max/min clamp to [0, limit]
  return `floor(max(0,min(${expr},${limitExpr}))/2)*2`;
}

function subtitlesFilter(srtOrAssPath: string): string {
  const ext = path.extname(srtOrAssPath).toLowerCase();
  const escaped = escapeSubtitlesPath(srtOrAssPath);
  const fontsDir = path.resolve(process.cwd(), "assets/fonts");
  const escapedFontsDir = fontsDir.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  if (ext === ".ass" || ext === ".ssa") {
    return "subtitles='" + escaped + "':fontsdir='" + escapedFontsDir + "'";
  }
  const force =
    "Alignment=5,FontName=Forever Freedom Regular Font Regular,FontSize=160,Bold=1," +
    "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000," +
    "Outline=0,Shadow=2,Spacing=3,MarginV=-20,MarginL=40,MarginR=40";
  return (
    "subtitles='" +
    escaped +
    "':fontsdir='" +
    escapedFontsDir +
    "':force_style='" +
    force +
    "'"
  );
}

export async function renderClip(
  input: string,
  startSec: number,
  endSec: number,
  srtPath: string | null,
  outFile: string,
): Promise<void> {
  const p = await probeVideo(input);
  const tgt = chooseTargetSize(p.width, p.height);
  const filters = buildFilters(tgt.w, tgt.h);
  const vf =
    srtPath && srtPath.length > 0
      ? filters + "," + subtitlesFilter(srtPath)
      : filters;
  const dur = Math.max(0, endSec - startSec);
  const args = [
    "-y",
    "-ss",
    String(startSec),
    "-t",
    String(dur),
    "-i",
    input,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "slow",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outFile,
  ];
  await run(ffmpegPath!, args);
  await fs.stat(outFile);
}

export async function probeBitrate(
  file: string,
): Promise<{ size: number; seconds: number; kbps: number }> {
  const { stdout } = await run(ffprobePath as string, [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size",
    "-of",
    "json",
    file,
  ]);
  const j = JSON.parse(stdout);
  const size = Number(j.format.size || 0);
  const seconds = Number(j.format.duration || 0);
  const kbps = seconds > 0 ? (size * 8) / seconds / 1000 : 0;
  return { size, seconds, kbps };
}

export function getFileSizeBytes(pathStr: string): number {
  const stat = require("fs").statSync(pathStr);
  return stat.size;
}

export async function getDurationSeconds(inputPath: string): Promise<number> {
  const { stdout } = await run(ffprobePath as string, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    inputPath,
  ]);
  const j = JSON.parse(stdout);
  return Number(j.format.duration || 0);
}

export interface SceneChange {
  timeSec: number;
}

export async function detectScenes(
  inputPath: string,
  threshold = 0.3,
): Promise<SceneChange[]> {
  const args = [
    "-i",
    inputPath,
    "-vf",
    `select='gt(scene,${threshold})',showinfo`,
    "-f",
    "null",
    "-",
  ];
  const { stderr } = await run(ffmpegPath!, args);
  const lines = stderr.split("\n");
  const changes: SceneChange[] = [];
  for (const line of lines) {
    const match = line.match(/pts_time:([\d.]+)/);
    if (match) {
      changes.push({ timeSec: parseFloat(match[1]) });
    }
  }
  return changes;
}

export async function extractAudio(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await run(ffmpegPath!, [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-acodec",
    "copy",
    outputPath,
  ]);
}

export async function compressAudioForTranscription(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await run(ffmpegPath!, [
    "-y",
    "-i",
    inputPath,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    outputPath,
  ]);
}

export async function extractThumbnail(
  videoPath: string,
  outputPath: string,
  timeSec: number,
): Promise<void> {
  await run(ffmpegPath!, [
    "-y",
    "-ss",
    String(timeSec),
    "-i",
    videoPath,
    "-vframes",
    "1",
    "-q:v",
    "2",
    outputPath,
  ]);
}

const MAX_CUE_DURATION = 4.5;
const MAX_CUE_GAP = 0.8;
const MAX_TOTAL_CHARACTERS = 84;
const MAX_LINE_LENGTH = 42;
const MAX_LINES_PER_CUE = 2;
const IDEAL_CHAR_BREAK = 28;
const SENTENCE_ENDING = /[.!?…]/;
const CLAUSE_ENDING = /[,;:\u2014\u2013]/;

interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export function createWordByWordSrtFile(
  words: Array<TimedWord>,
  outputPath: string,
): void {
  const sanitized = words
    .map((w) => ({ ...w, word: sanitizeWord(w.word) }))
    .filter((w) => w.word.length > 0);
  if (sanitized.length === 0) {
    writeFileSync(outputPath, "");
    return;
  }
  let idx = 1;
  const cues: string[] = [];
  for (const word of sanitized) {
    const start = formatSrtTime(word.start);
    const end = formatSrtTime(word.end);
    cues.push([String(idx++), `${start} --> ${end}`, word.word].join("\n"));
  }
  writeFileSync(outputPath, cues.join("\n\n") + "\n");
}

export function createSrtFile(
  words: Array<TimedWord>,
  outputPath: string,
): void {
  const sanitizedWords = words
    .map((w) => ({ ...w, word: sanitizeWord(w.word) }))
    .filter((w) => w.word.length > 0);
  if (sanitizedWords.length === 0) {
    writeFileSync(outputPath, "");
    return;
  }
  const cues: string[] = [];
  let currentCue: TimedWord[] = [];
  let cueStart = sanitizedWords[0].start;

  const flushCue = () => {
    if (currentCue.length === 0) {
      return;
    }
    const startTime = formatSrtTime(cueStart);
    const endTime = formatSrtTime(currentCue[currentCue.length - 1].end);
    const lines = formatCueLines(currentCue);
    cues.push(
      [String(cues.length + 1), `${startTime} --> ${endTime}`, ...lines].join(
        "\n",
      ),
    );
    currentCue = [];
  };

  sanitizedWords.forEach((word, index) => {
    const previousWord = currentCue[currentCue.length - 1];
    if (previousWord) {
      const gap = word.start - previousWord.end;
      if (gap >= MAX_CUE_GAP) {
        flushCue();
      }
    }
    if (currentCue.length === 0) {
      cueStart = word.start;
    }
    const candidateCue = [...currentCue, word];
    const candidateDuration = word.end - cueStart;
    const candidateChars = measureCueCharacters(candidateCue);
    if (
      currentCue.length > 0 &&
      (candidateDuration > MAX_CUE_DURATION ||
        candidateChars > MAX_TOTAL_CHARACTERS)
    ) {
      flushCue();
      cueStart = word.start;
    }
    currentCue.push(word);
    const currentDuration = currentCue[currentCue.length - 1].end - cueStart;
    const currentChars = measureCueCharacters(currentCue);
    const nextWord = sanitizedWords[index + 1];
    const endsSentence = endsWithRegex(word.word, SENTENCE_ENDING);
    const endsClause = endsWithRegex(word.word, CLAUSE_ENDING);
    if (endsSentence) {
      flushCue();
      return;
    }
    if (
      endsClause &&
      (currentChars >= IDEAL_CHAR_BREAK ||
        currentDuration >= MAX_CUE_DURATION / 2)
    ) {
      flushCue();
      return;
    }
    if (!nextWord) {
      flushCue();
      return;
    }
    const gapToNext = nextWord.start - word.end;
    if (gapToNext >= MAX_CUE_GAP) {
      flushCue();
      return;
    }
    if (
      currentDuration >= MAX_CUE_DURATION ||
      currentChars >= MAX_TOTAL_CHARACTERS
    ) {
      flushCue();
    }
  });

  flushCue();
  const srtContent = cues.join("\n\n") + "\n";
  writeFileSync(outputPath, srtContent);
}

export function createAssWordByWordFile(
  words: Array<TimedWord>,
  outputPath: string,
  wordsPerSubtitle: number = 1,
): void {
  const sanitized = words
    .map((w) => ({ ...w, word: sanitizeWord(w.word) }))
    .filter((w) => w.word.length > 0);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Forever Freedom Regular Font Regular,160,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,3,0,1,0,2,5,40,40,0,0",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  const lines: string[] = [];
  for (let i = 0; i < sanitized.length; i += wordsPerSubtitle) {
    const group = sanitized.slice(i, i + wordsPerSubtitle);
    if (group.length === 0) {
      continue;
    }
    const start = formatAssTime(group[0].start);
    const end = formatAssTime(group[group.length - 1].end);
    const text = group
      .map((w) => w.word)
      .join(" ")
      .replace(/{/g, "｛")
      .replace(/}/g, "｝");
    lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
  }
  const content = header.concat(lines).join("\n") + "\n";
  writeFileSync(outputPath, content);
}

function sanitizeWord(word: string): string {
  return word.replace(/\s+/g, " ").trim();
}

function measureCueCharacters(words: TimedWord[]): number {
  return buildCueText(words).length;
}

function buildCueText(words: TimedWord[]): string {
  const joined = words.map((w) => w.word).join(" ");
  return joined
    .replace(/\s+([,.;!?…:\u2014\u2013])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function formatCueLines(words: TimedWord[]): string[] {
  const text = buildCueText(words);
  if (text.length === 0) {
    return [""];
  }
  let lines = wrapText(text, MAX_LINE_LENGTH);
  if (lines.length > MAX_LINES_PER_CUE) {
    lines = rebalanceLines(words);
  }
  return lines;
}

function wrapText(text: string, maxLen: number): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current.length > 0 ? `${current} ${token}` : token;
    if (candidate.length <= maxLen || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current);
      current = token;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function rebalanceLines(words: TimedWord[]): string[] {
  const tokens = buildCueText(words).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return [""];
  }
  let bestSplit = Math.ceil(tokens.length / 2);
  let bestLines = [
    tokens.slice(0, bestSplit).join(" "),
    tokens.slice(bestSplit).join(" "),
  ];
  let bestScore = Math.max(...bestLines.map((l) => l.length));
  for (let i = 1; i < tokens.length; i++) {
    const left = tokens.slice(0, i).join(" ");
    const right = tokens.slice(i).join(" ");
    const leftLength = left.length;
    const rightLength = right.length;
    const score = Math.max(leftLength, rightLength);
    if (
      leftLength <= MAX_LINE_LENGTH &&
      rightLength <= MAX_LINE_LENGTH &&
      score < bestScore
    ) {
      bestLines = [left, right];
      bestScore = score;
    }
  }
  if (
    bestLines[0].length <= MAX_LINE_LENGTH &&
    bestLines[1].length <= MAX_LINE_LENGTH
  ) {
    return bestLines;
  }
  const wrapped = wrapText(tokens.join(" "), MAX_LINE_LENGTH);
  if (wrapped.length <= MAX_LINES_PER_CUE) {
    return wrapped;
  }
  const firstLines = wrapped.slice(0, MAX_LINES_PER_CUE - 1);
  const remaining = wrapped.slice(MAX_LINES_PER_CUE - 1).join(" ");
  return [...firstLines, remaining.trim()].filter((line) => line.length > 0);
}

function endsWithRegex(text: string, regex: RegExp): boolean {
  return regex.test(text.slice(-1));
}

function formatSrtTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(ms, 3)}`;
}

function formatAssTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const cs = Math.floor(((seconds % 1) * 1000) / 10);
  return `${pad(hours, 1)}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(cs, 2)}`;
}

function pad(num: number, size: number): string {
  let s = num.toString();
  while (s.length < size) {
    s = "0" + s;
  }
  return s;
}

interface RenderVerticalClipOptions {
  inputPath: string;
  outputPath: string;
  startTime: number;
  duration: number;
  srtPath?: string;
  hookText?: string;
}

export async function renderVerticalClip(
  options: RenderVerticalClipOptions,
): Promise<void> {
  const p = await probeVideo(options.inputPath);
  const tgt = chooseTargetSize(p.width, p.height);
  const filters = buildFilters(tgt.w, tgt.h);
  let vf = filters;
  if (options.srtPath && options.srtPath.length > 0) {
    vf = vf + "," + subtitlesFilter(options.srtPath);
  }
  if (options.hookText && options.hookText.length > 0) {
    const hookEscaped = escapeDrawtext(options.hookText);
    const fontPath = path.resolve(
      process.cwd(),
      "assets/fonts/Forever-Freedom-Regular.ttf",
    );
    const escapedFontPath = fontPath
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:");
    const hookFilter =
      "drawtext=text='" +
      hookEscaped +
      "':fontfile='" +
      escapedFontPath +
      "':fontsize=30:fontcolor=white:borderw=0:bordercolor=black:x=(w-text_w)/2:y=120";
    vf = vf + "," + hookFilter;
  }
  const dur = Math.max(0, options.duration);
  const args = [
    "-y",
    "-ss",
    String(options.startTime),
    "-t",
    String(dur),
    "-i",
    options.inputPath,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "slow",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    options.outputPath,
  ];
  await run(ffmpegPath!, args);
  await fs.stat(options.outputPath);
}

interface RenderSmartFramedClipOptions {
  inputPath: string;
  outputPath: string;
  startTime: number;
  duration: number;
  srtPath: string;
  hookText?: string;
  filterExpr?: string;
  cropMapExprX?: string;
  cropMapExprY?: string;
  cropW?: number;
  cropH?: number;
}

//gpt
export async function renderSmartFramedClip(
  options: RenderSmartFramedClipOptions,
): Promise<void> {
  let vfString: string;

  if (options.filterExpr) {
    vfString = options.filterExpr;
    if (options.srtPath && options.srtPath.length > 0) {
      vfString = vfString + "," + subtitlesFilter(options.srtPath);
    }
    if (options.hookText && options.hookText.length > 0) {
      const hookEscaped = escapeDrawtext(options.hookText);
      const fontPath = path.resolve(
        process.cwd(),
        "assets/fonts/Forever-Freedom-Regular.ttf",
      );
      const escapedFontPath = fontPath
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:");
      const hookFilter =
        "drawtext=text='" +
        hookEscaped +
        "':fontfile='" +
        escapedFontPath +
        "':fontsize=30:fontcolor=white:borderw=0:bordercolor=black:x=(w-text_w)/2:y=120";
      vfString = vfString + "," + hookFilter;
    }
  } else {
    // 👇 add these three lines at the START of the else-branch
    const p = await probeVideo(options.inputPath);
    const CROP_W = even(Math.min(options.cropW ?? 1080, p.width));
    const CROP_H = even(Math.min(options.cropH ?? 1080, p.height));

    // user provides expressions for x(t) / y(t); keep them unquoted inside clamp
    const xExprRaw = options.cropMapExprX ?? "0";
    const yExprRaw = options.cropMapExprY ?? "0";

    // clamp to video bounds and snap to even pixels
    const xExpr = clampExpr(xExprRaw, `(iw-${CROP_W})`);
    const yExpr = clampExpr(yExprRaw, `(ih-${CROP_H})`);

    // IMPORTANT: animate ONLY x/y; w/h are constants
    const cropFilter = `crop=${CROP_W}:${CROP_H}:${xExpr}:${yExpr}`;

    vfString = `${cropFilter},scale=1080:1920,format=yuv420p`;

    if (options.srtPath && options.srtPath.length > 0) {
      vfString = vfString + "," + subtitlesFilter(options.srtPath);
    }
    if (options.hookText && options.hookText.length > 0) {
      const hookEscaped = escapeDrawtext(options.hookText);
      const fontPath = path.resolve(process.cwd(), "assets/fonts/Forever-Freedom-Regular.ttf");
      const escapedFontPath = fontPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
      const hookFilter =
        "drawtext=text='" + hookEscaped +
        "':fontfile='" + escapedFontPath +
        "':fontsize=30:fontcolor=white:borderw=0:bordercolor=black:x=(w-text_w)/2:y=120";
      vfString = vfString + "," + hookFilter;
    }
  }


  const dur = Math.max(0, options.duration);
  const useScript = vfString.length > 60000;
  const vfArgs = useScript
    ? ["-filter_script:v", await writeFilterScript(vfString)]
    : ["-vf", vfString];

  const args = [
    "-y",
    "-ss",
    String(options.startTime),
    "-t",
    String(dur),
    "-i",
    options.inputPath,
    ...vfArgs,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "slow",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    options.outputPath,
  ];

  await run(ffmpegPath!, args);
  await fs.stat(options.outputPath);
}

/*export async function renderSmartFramedClip(
  options: RenderSmartFramedClipOptions,
): Promise<void> {
  let vf: string;
  if (options.filterExpr) {
    vf = options.filterExpr;
    if (options.srtPath && options.srtPath.length > 0) {
      vf = vf + "," + subtitlesFilter(options.srtPath);
    }
    if (options.hookText && options.hookText.length > 0) {
      const hookEscaped = escapeDrawtext(options.hookText);
      const fontPath = path.resolve(
        process.cwd(),
        "assets/fonts/Forever-Freedom-Regular.ttf",
      );
      const escapedFontPath = fontPath
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:");
      const hookFilter =
        "drawtext=text='" +
        hookEscaped +
        "':fontfile='" +
        escapedFontPath +
        "':fontsize=30:fontcolor=white:borderw=0:bordercolor=black:x=(w-text_w)/2:y=120";
      vf = vf + "," + hookFilter;
    }
  } else {
    const cropFilter = `crop=${options.cropW}:${options.cropH}:'${options.cropMapExprX}':'${options.cropMapExprY}'`;
    vf = cropFilter + ",scale=1080:1920,format=yuv420p";
    if (options.srtPath && options.srtPath.length > 0) {
      vf = vf + "," + subtitlesFilter(options.srtPath);
    }
    if (options.hookText && options.hookText.length > 0) {
      const hookEscaped = escapeDrawtext(options.hookText);
      const fontPath = path.resolve(
        process.cwd(),
        "assets/fonts/Forever-Freedom-Regular.ttf",
      );
      const escapedFontPath = fontPath
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:");
      const hookFilter =
        "drawtext=text='" +
        hookEscaped +
        "':fontfile='" +
        escapedFontPath +
        "':fontsize=30:fontcolor=white:borderw=0:bordercolor=black:x=(w-text_w)/2:y=120";
      vf = vf + "," + hookFilter;
    }
  }
  const dur = Math.max(0, options.duration);
  const args = [
    "-y",
    "-ss",
    String(options.startTime),
    "-t",
    String(dur),
    "-i",
    options.inputPath,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "slow",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    options.outputPath,
  ];
  await run(ffmpegPath!, args);
  await fs.stat(options.outputPath);
}*/
