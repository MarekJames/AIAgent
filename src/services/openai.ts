import OpenAI from "openai";
import { createReadStream, statSync } from "fs";
import { getFileSizeBytes, getDurationSeconds } from "./ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { join } from "path";

ffmpeg.setFfmpegPath(ffmpegPath!);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 600000,
  maxRetries: 3,
});

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
  words: TranscriptWord[];
  language?: string;
}

const TARGET_MB = parseFloat(process.env.OPENAI_CHUNK_TARGET_MB || "24.5");
const TARGET_BYTES = Math.floor(TARGET_MB * 1024 * 1024);
const MAX_RETRIES = parseInt(process.env.OPENAI_MAX_RETRIES || "2", 10);

export async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let delay = 1000;

  for (;;) {
    try {
      const res = await fn();
      return res;
    } catch (err: any) {
      attempt = attempt + 1;
      const code = err?.status || err?.code || 0;
      const transient =
        code === 429 ||
        code === 408 ||
        code === 500 ||
        code === 502 ||
        code === 503 ||
        code === 504;

      if (attempt > MAX_RETRIES) {
        throw err;
      }

      if (!transient) {
        throw err;
      }

      await new Promise((r) => {
        setTimeout(r, delay);
      });
      delay = delay * 2;
    }
  }
}

export async function planAudioChunksBySize(
  inputPath: string,
  durationSec: number,
): Promise<{ start: number; duration: number }[]> {
  const sizeBytes = getFileSizeBytes(inputPath);
  let chunks = Math.ceil(sizeBytes / TARGET_BYTES);

  if (chunks < 1) {
    chunks = 1;
  }

  const base = Math.floor(durationSec / chunks);
  const rem = durationSec - base * chunks;
  const plan: { start: number; duration: number }[] = [];
  let cursor = 0;

  for (let i = 0; i < chunks; i++) {
    let d = base;

    if (i < rem) {
      d = d + 1;
    }

    plan.push({ start: cursor, duration: d });
    cursor = cursor + d;
  }

  return plan;
}

async function extractAudioChunk(
  inputPath: string,
  outputPath: string,
  start: number,
  duration: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(start)
      .duration(duration)
      .outputOptions(["-c:a", "copy"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

async function transcribeAudioFile(
  audioPath: string,
  timeOffset: number = 0,
  retries = 5,
): Promise<{ words: TranscriptWord[]; language: string }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await openai.audio.transcriptions.create({
        file: createReadStream(audioPath),
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["word"],
      });

      const words: TranscriptWord[] = [];

      if (response.words) {
        for (const word of response.words) {
          words.push({
            word: word.word,
            start: word.start + timeOffset,
            end: word.end + timeOffset,
          });
        }
      }

      const detectedLanguage = response.language || "en";
      console.log(`Detected language: ${detectedLanguage}`);

      return { words, language: detectedLanguage };
    } catch (error: any) {
      lastError = error;

      if (
        error.code === "ECONNRESET" ||
        error.cause?.code === "ECONNRESET" ||
        error.status === 500 ||
        error.status === 503
      ) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        console.log(
          `Transcription attempt ${attempt}/${retries} failed with network error. Retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("Failed to transcribe audio after retries");
}

function isIntroChapter(title: string, detectedLanguage?: string): boolean {
  const titleLower = title.toLowerCase().trim();

  const introKeywords: Record<string, string[]> = {
    en: ["intro", "introduction", "opening", "welcome", "trailer", "credits"],
    es: [
      "intro",
      "introduccion",
      "introducci\u00f3n",
      "apertura",
      "inicio",
      "inicio del video",
      "inicio del v\u00eddeo",
      "bienvenida",
    ],
    pt: [
      "intro",
      "introducao",
      "introdu\u00e7ao",
      "introdu\u00e7\u00e3o",
      "apresentacao",
      "apresenta\u00e7ao",
      "apresenta\u00e7\u00e3o",
      "abertura",
      "boas-vindas",
    ],
    fr: ["intro", "introduction", "ouverture", "bienvenue"],
    de: [
      "intro",
      "einf\u00fchrung",
      "einleitung",
      "er\u00f6ffnung",
      "willkommen",
    ],
    it: ["intro", "introduzione", "apertura", "benvenuto"],
    ja: ["イントロ", "紹介", "オープニング"],
    ko: ["인트로", "소개", "오프닝"],
    zh: ["介绍", "简介", "开场"],
    ru: ["вступление", "введение", "открытие"],
  };

  let keywordsToCheck = introKeywords["en"] || [];

  if (detectedLanguage && introKeywords[detectedLanguage]) {
    keywordsToCheck = [
      ...introKeywords[detectedLanguage],
      ...introKeywords["en"],
    ];
  } else {
    keywordsToCheck = Object.values(introKeywords).flat();
  }

  for (const keyword of keywordsToCheck) {
    if (titleLower.includes(keyword)) {
      return true;
    }
  }

  if (
    titleLower.length < 20 &&
    titleLower.match(
      /^(chapter|cap[íi]tulo|part|parte|section|se[cç][aã]o|episode|epis[óo]dio)\s*[0-9]+/,
    )
  ) {
    return false;
  }

  return false;
}

function calculateIntroSkip(chapters: any[], duration: number): number {
  const defaultSkip = parseInt(process.env.INTRO_SKIP_SECONDS || "180", 10);

  if (!chapters || chapters.length === 0) {
    console.log(`No chapters found, using default skip: ${defaultSkip}s`);
    return defaultSkip;
  }

  const firstChapter = chapters[0];

  if (isIntroChapter(firstChapter.title)) {
    const chapterEnd = firstChapter.endSec || firstChapter.end_time || 0;
    console.log(
      `First chapter "${firstChapter.title}" detected as intro, skipping to ${chapterEnd}s`,
    );
    return chapterEnd;
  }

  console.log(
    `First chapter "${firstChapter.title}" not detected as intro, processing from start`,
  );
  return 0;
}

export async function transcribeAudio(
  audioPath: string,
  chapters: any[] = [],
): Promise<TranscriptSegment[]> {
  const fileSize = getFileSizeBytes(audioPath);
  const duration = await getDurationSeconds(audioPath);

  const introSkip = calculateIntroSkip(chapters, duration);

  let effectiveStart = 0;

  if (duration > introSkip) {
    effectiveStart = introSkip;
    console.log(`Skipping first ${introSkip}s of audio (intro skip)`);
  }

  const effectiveDuration = duration - effectiveStart;
  let allWords: TranscriptWord[] = [];
  let detectedLanguage = "en";

  if (fileSize > TARGET_BYTES) {
    console.log(
      `Audio file is ${(fileSize / 1024 / 1024).toFixed(1)}MB, splitting into chunks...`,
    );
    const chunkPlan = await planAudioChunksBySize(audioPath, effectiveDuration);

    console.log(
      `Transcribing ${chunkPlan.length} chunks in parallel (max 3 concurrent)...`,
    );

    const audioDir = audioPath.substring(0, audioPath.lastIndexOf("/"));
    const audioExt = audioPath.substring(audioPath.lastIndexOf("."));

    const transcribeChunk = async (
      plan: { start: number; duration: number },
      index: number,
    ) => {
      console.log(`Transcribing chunk ${index + 1}/${chunkPlan.length}`);
      const chunkPath = join(audioDir, `chunk_${index}${audioExt}`);
      const absoluteStart = effectiveStart + plan.start;
      await extractAudioChunk(
        audioPath,
        chunkPath,
        absoluteStart,
        plan.duration,
      );
      return await transcribeAudioFile(chunkPath, absoluteStart);
    };

    const chunkResults: { words: TranscriptWord[]; language: string }[] = [];
    const chunkErrors: Array<{ index: number; error: any }> = [];

    for (let i = 0; i < chunkPlan.length; i += 3) {
      const batch = chunkPlan.slice(i, i + 3);
      const batchResults = await Promise.allSettled(
        batch.map((plan, idx) => transcribeChunk(plan, i + idx)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];

        if (result.status === "fulfilled") {
          chunkResults.push(result.value);
        } else {
          const chunkIndex = i + j;
          console.error(
            `Chunk ${chunkIndex + 1} failed to transcribe:`,
            result.reason,
          );
          chunkErrors.push({ index: chunkIndex, error: result.reason });
        }
      }
    }

    if (chunkErrors.length > 0 && chunkResults.length === 0) {
      throw new Error(
        `All chunks failed to transcribe. Errors: ${JSON.stringify(chunkErrors)}`,
      );
    }

    if (chunkResults.length > 0) {
      detectedLanguage = chunkResults[0].language;
    }

    allWords = chunkResults.flatMap((r) => r.words);
  } else {
    let result: { words: TranscriptWord[]; language: string };

    if (effectiveStart > 0) {
      const audioDir = audioPath.substring(0, audioPath.lastIndexOf("/"));
      const audioExt = audioPath.substring(audioPath.lastIndexOf("."));
      const skippedPath = join(audioDir, `skipped${audioExt}`);
      await extractAudioChunk(
        audioPath,
        skippedPath,
        effectiveStart,
        effectiveDuration,
      );
      result = await transcribeAudioFile(skippedPath, effectiveStart);
    } else {
      result = await transcribeAudioFile(audioPath);
    }

    allWords = result.words;
    detectedLanguage = result.language;
  }

  const segments: TranscriptSegment[] = [];
  let currentSegment: TranscriptWord[] = [];
  let segmentStart = 0;
  let segmentText = "";

  for (let i = 0; i < allWords.length; i++) {
    const word = allWords[i];

    if (currentSegment.length === 0) {
      segmentStart = word.start;
    }

    currentSegment.push(word);
    segmentText += word.word + " ";

    if (i < allWords.length - 1) {
      const gap = allWords[i + 1].start - word.end;

      if (gap > 0.9 || currentSegment.length >= 50) {
        segments.push({
          text: segmentText.trim(),
          start: segmentStart,
          end: word.end,
          words: currentSegment,
          language: detectedLanguage,
        });

        currentSegment = [];
        segmentText = "";
      }
    }
  }

  if (currentSegment.length > 0) {
    segments.push({
      text: segmentText.trim(),
      start: segmentStart,
      end: currentSegment[currentSegment.length - 1].end,
      words: currentSegment,
      language: detectedLanguage,
    });
  }

  console.log(
    `Transcription complete. Language: ${detectedLanguage}, Segments: ${segments.length}`,
  );

  return segments;
}

export interface ScoreResult {
  category: string;
  tags: string[];
  scores: {
    hook_strength: number;
    retention_likelihood: number;
    clarity: number;
    shareability: number;
    overall: number;
  };
  rationale: string;
}

export function isSentenceBoundaryToken(token: string): boolean {
  const t = token?.trim?.() || ''
  if (!t) { return false }
  if (/[.!?…]$/.test(t)) { return true }
  if (/--$/.test(t)) { return true }
  return false
}

export async function scoreClip(
  title: string,
  hook: string,
  transcript: string,
): Promise<ScoreResult> {
  return withRetries(async () => {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are an expert at scoring short-form video clips for TikTok, Instagram Reels, and YouTube Shorts viral potential.",
        },
        {
          role: "user",
          content: `Analyze this short video clip for viral potential on TikTok/Reels/Shorts.

CRITICAL HOOK CRITERIA (first 1.5-2.0 seconds):
- Must grab attention immediately with question, bold claim, or intrigue
- Avoid slow cold opens - needs energy from frame 1
- Strong hooks: "How to...", "X vs Y", questions, shocking facts, controversy, numbers

RETENTION SIGNALS:
- Fast pacing, low pause density, rising energy
- Clear Q→A arc or story structure
- Visual variety without being chaotic (2-4 scene changes ideal)
- Payoff delivered by end, no trailing off

TIKTOK-SPECIFIC:
- First 2 seconds determine everything
- Must work with sound OFF (assume subtitles carry meaning)
- Clarity over complexity
- Shareability: meme-able, relatable, or teaches something

SCORING RUBRIC:
- hook_strength (0-10): How compelling are the first 2 seconds for a cold audience?
- retention_likelihood (0-10): Will viewers watch to the end? Pacing, payoff, engagement?
- clarity (0-10): Is the message crystal clear? Minimal filler, coherent flow?
- shareability (0-10): Would someone share this or save it? Relatable, useful, or entertaining?
- overall (0-100): Weighted viral potential score

Return JSON with:
{
  "category": "[Education|Motivation|Humor|Commentary|Tech|Lifestyle|News|Finance|Health|Sports|Gaming|Other]",
  "tags": ["tag1", "tag2", "tag3"],
  "scores": {
    "hook_strength": <0-10>,
    "retention_likelihood": <0-10>,
    "clarity": <0-10>,
    "shareability": <0-10>,
    "overall": <0-100>
  },
  "rationale": "<one sentence explaining overall score>"
}

INPUT:
Title: ${title}
Hook (first 2-3s): ${hook}
Full transcript: ${transcript}

JSON only, no markdown.`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const content = response.choices[0].message.content || "{}";
    return JSON.parse(content) as ScoreResult;
  });
}
