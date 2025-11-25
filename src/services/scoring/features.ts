export type Word = {
  start: number
  end: number
  text: string
  confidence?: number
}

export type Segment = {
  id: string
  videoId: string
  start: number
  end: number
  transcript: string
  words: Word[]
  sceneCuts?: number[]
  faces?: number
  motion?: number
  loudness?: number
  laughs?: number
  questions?: number
  aiScore?: number
  embedding?: number[]
  safety?: number
}

export type Features = {
  duration: number
  durationTarget: number
  durationPenalty: number
  speechContinuity: number
  sentenceCompleteness: number
  silenceRatio: number
  cutDensity: number
  facePresence: number
  motionScore: number
  loudnessScore: number
  hookness: number
  questionLead: number
  laughMoments: number
  novelty: number
  coherence: number
  safety: number
}

export function computeFeatures(segment: Segment, targetDuration: number, videoEmbedding?: number[]): Features {
  const duration = Math.max(0, segment.end - segment.start)
  const toleranceLow = 10
  const toleranceHigh = 15
  const minAccept = Math.max(0, targetDuration - toleranceLow)
  const maxAccept = targetDuration + toleranceHigh
  const durationPenalty = durationFitPenalty(duration, targetDuration, minAccept, maxAccept)
  const speechContinuity = continuityScore(segment.words)
  const sentenceCompleteness = completenessScore(segment.transcript, segment.words)
  const silenceRatio = silenceScore(segment.words, duration)
  const cutDensity = cutScore(segment.sceneCuts, segment.start, segment.end)
  const facePresence = normalize01(segment.faces ?? 0, 0, 1)
  const motionScore = normalize01(segment.motion ?? 0, 0, 1)
  const loudnessScore = normalize01(segment.loudness ?? 0, 0, 1)
  const hookness = hookScore(segment.words, 5)
  const questionLead = normalize01(segment.questions ?? 0, 0, 3)
  const laughMoments = normalize01(segment.laughs ?? 0, 0, 3)
  const novelty = noveltyScore(segment.embedding, videoEmbedding)
  const coherence = coherenceScore(segment.words)
  const safety = normalize01(segment.safety ?? 1, 0, 1)
  return {
    duration,
    durationTarget: targetDuration,
    durationPenalty,
    speechContinuity,
    sentenceCompleteness,
    silenceRatio,
    cutDensity,
    facePresence,
    motionScore,
    loudnessScore,
    hookness,
    questionLead,
    laughMoments,
    novelty,
    coherence,
    safety
  }
}

function durationFitPenalty(actual: number, target: number, minAccept: number, maxAccept: number): number {
  if (actual < minAccept) { return 1 }
  if (actual > maxAccept) { return 1 }
  const mid = target
  const d = Math.abs(actual - mid)
  const span = Math.max(mid - minAccept, maxAccept - mid)
  const p = d / span
  return clamp01(p)
}

function continuityScore(words: Word[]): number {
  if (words.length < 2) { return 0 }
  let longPauses = 0
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap > 0.8) { longPauses = longPauses + 1 }
  }
  const rate = longPauses / Math.max(1, words.length - 1)
  return 1 - clamp01(rate)
}

function completenessScore(transcript: string, words: Word[]): number {
  const trimmed = transcript.trim()
  const punct = /[.!?…]$/
  if (punct.test(trimmed)) { return 1 }
  const last = words[words.length - 1]
  if (!last) { return 0 }
  const trailing = last.end - last.start
  if (trailing > 0.6) { return 0.7 }
  return 0.4
}

function silenceScore(words: Word[], duration: number): number {
  if (duration <= 0) { return 1 }
  if (words.length === 0) { return 1 }
  let totalSilence = 0
  let lastEnd = words[0].end
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - lastEnd
    if (gap > 0) { totalSilence = totalSilence + gap }
    lastEnd = words[i].end
  }
  const ratio = clamp01(totalSilence / duration)
  return 1 - ratio
}

function cutScore(cuts: number[] | undefined, start: number, end: number): number {
  if (!cuts || cuts.length === 0) { return 0.5 }
  const within = cuts.filter(c => c >= start && c <= end)
  const density = within.length / Math.max(1, end - start)
  const targetDensity = 0.015
  const diff = Math.abs(density - targetDensity)
  const span = targetDensity
  return 1 - clamp01(diff / span)
}

function hookScore(words: Word[], seconds: number): number {
  if (words.length === 0) { return 0 }
  const startAt = words[0].start
  const windowEnd = startAt + seconds
  const firstWords = words.filter(w => w.start <= windowEnd).map(w => w.text.toLowerCase())
  const phrases = ["here's why","the truth is","no one tells you","what happened was","the secret","mistake","hack","watch this","did you know","let me tell you","biggest"]
  let score = 0
  for (const p of phrases) { if (firstWords.join(' ').includes(p)) { score = score + 1 } }
  const q = firstWords.includes('why') || firstWords.includes('how') || firstWords.includes('what') ? 0.3 : 0
  return clamp01(score * 0.3 + q)
}

function noveltyScore(emb?: number[], videoEmb?: number[]): number {
  if (!emb || !videoEmb) { return 0.5 }
  const sim = cosine(emb, videoEmb)
  return clamp01(1 - sim)
}

function coherenceScore(words: Word[]): number {
  if (words.length < 2) { return 0 }
  let badBreaks = 0
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap > 1.2) { badBreaks = badBreaks + 1 }
  }
  const r = badBreaks / Math.max(1, words.length - 1)
  return 1 - clamp01(r)
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) { return 0 }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot = dot + a[i] * b[i]
    na = na + a[i] * a[i]
    nb = nb + b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) { return 0 }
  return clamp01((dot / denom + 1) / 2)
}

function normalize01(v: number, min: number, max: number): number {
  if (max === min) { return 0 }
  const n = (v - min) / (max - min)
  return clamp01(n)
}

function clamp01(v: number): number {
  if (v < 0) { return 0 }
  if (v > 1) { return 1 }
  return v
}
