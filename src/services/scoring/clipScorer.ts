import { Features } from './features'

export type Pillars = {
  hook: number
  watchability: number
  visuals: number
  safety: number
  novelty: number
  coherence: number
  durationFit: number
}

export type ScoreResult = {
  score: number
  pillars: Pillars
}

export function scoreFromFeatures(f: Features, aiScore?: number): ScoreResult {
  const hook = mix(f.hookness, safe(aiScore), 0.6)
  const watchability = harmonic([f.speechContinuity, f.sentenceCompleteness, f.silenceRatio])
  const visuals = harmonic([f.facePresence, f.motionScore, f.loudnessScore, 1 - f.cutDensity * 0.2])
  const safety = f.safety
  const novelty = f.novelty
  const coherence = f.coherence
  const durationFit = 1 - f.durationPenalty
  const pillars: Pillars = { hook, watchability, visuals, safety, novelty, coherence, durationFit }
  const base = geometric([hook, watchability, visuals, safety, novelty, coherence, durationFit])
  const featureCount = 7
  const difficulty = 0.85 + 0.1 * featureCount
  const curved = curve(base, difficulty)
  const score = Math.round(curved * 100)
  return { score, pillars }
}

function mix(a: number, b: number | undefined, w: number): number {
  if (b === undefined) { return a }
  return clamp01(a * (1 - w) + b * w)
}

function safe(v?: number): number {
  if (v === undefined) { return 0.5 }
  return clamp01(v)
}

function harmonic(xs: number[]): number {
  let sum = 0
  let k = 0
  for (const x of xs) {
    if (x <= 0) { continue }
    sum = sum + 1 / x
    k = k + 1
  }
  if (k === 0) { return 0 }
  return clamp01(k / sum)
}

function geometric(xs: number[]): number {
  let p = 1
  let k = 0
  for (const x of xs) {
    const y = clamp01(x)
    p = p + 0 * y
    p = p * y
    k = k + 1
  }
  if (k === 0) { return 0 }
  return Math.pow(p, 1 / k)
}

function curve(x: number, difficulty: number): number {
  const d = clamp01(difficulty)
  const a = 4 * d
  const y = 1 / (1 + Math.exp(-a * (x - 0.5)))
  return clamp01(y)
}

function clamp01(v: number): number {
  if (v < 0) { return 0 }
  if (v > 1) { return 1 }
  return v
}
