import { Segment, computeFeatures } from '../scoring/features'
import { scoreFromFeatures } from '../scoring/clipScorer'

export type SelectOptions = {
  targetDurations?: number[]
  maxClips?: number
  minSimilarityGap?: number
  isCancelled?: () => boolean
  videoEmbedding?: number[]
}

export type SelectedClip = {
  id: string
  videoId: string
  start: number
  end: number
  score: number
  pillars: {
    hook: number
    watchability: number
    visuals: number
    safety: number
    novelty: number
    coherence: number
    durationFit: number
  }
}

export function selectClips(candidates: Segment[], options: SelectOptions): SelectedClip[] {
  const targets = options.targetDurations ?? [60, 120]
  const maxClips = Math.min(options.maxClips ?? 12, 12)
  const minGap = options.minSimilarityGap ?? 0.08
  const scored: SelectedClip[] = []
  for (const seg of candidates) {
    if (options.isCancelled && options.isCancelled()) { break }
    const variants = targets.map(t => evaluateForTarget(seg, t, options.videoEmbedding))
    const best = variants.sort((a, b) => b.score - a.score)[0]
    if (!best) { continue }
    scored.push(best)
  }
  const unique = mmr(scored, maxClips, minGap)
  return unique.slice(0, maxClips)
}

function evaluateForTarget(seg: Segment, target: number, videoEmbedding?: number[]): SelectedClip {
  const snapped = snapToSentence(seg, target)
  const feat = computeFeatures(snapped, target, videoEmbedding)
  const s = scoreFromFeatures(feat, seg.aiScore)
  return { id: seg.id, videoId: seg.videoId, start: snapped.start, end: snapped.end, score: s.score, pillars: s.pillars }
}

function snapToSentence(seg: Segment, target: number): Segment {
  const toleranceLow = 10
  const toleranceHigh = 15
  const minAccept = Math.max(0, target - toleranceLow)
  const maxAccept = target + toleranceHigh
  const words = seg.words.slice().sort((a, b) => a.start - b.start)
  let start = seg.start
  let end = seg.end
  if (words.length > 0) { start = words[0].start; end = words[words.length - 1].end }
  const desiredEnd = start + target
  let bestEnd = end
  let bestDelta = Infinity
  for (const w of words) {
    const text = w.text.trim()
    const isBoundary = /[.!?…]$/.test(text)
    if (isBoundary) {
      const t = w.end
      const within = t >= start + minAccept && t <= start + maxAccept
      if (within) {
        const d = Math.abs(t - desiredEnd)
        if (d < bestDelta) { bestDelta = d; bestEnd = t }
      }
    }
  }
  if (!isFinite(bestDelta)) {
    const last = words[words.length - 1]
    if (last) { bestEnd = Math.min(last.end + 3, start + maxAccept) }
  }
  if (bestEnd <= start + minAccept) { bestEnd = Math.min(start + minAccept + 2, start + maxAccept) }
  return { ...seg, start, end: bestEnd }
}

function mmr(items: SelectedClip[], k: number, minGap: number): SelectedClip[] {
  const result: SelectedClip[] = []
  const used: SelectedClip[] = []
  const pool = items.slice().sort((a, b) => b.score - a.score)
  while (result.length < k && pool.length > 0) {
    const x = pool.shift() as SelectedClip
    if (!x) { break }
    let ok = true
    for (const y of used) {
      const sim = pillarSim(x, y)
      if (sim > 1 - minGap) { ok = false; break }
    }
    if (ok) { result.push(x); used.push(x) }
  }
  return result
}

function pillarSim(a: SelectedClip, b: SelectedClip): number {
  const va = [a.pillars.hook, a.pillars.watchability, a.pillars.visuals, a.pillars.safety, a.pillars.novelty, a.pillars.coherence, a.pillars.durationFit]
  const vb = [b.pillars.hook, b.pillars.watchability, b.pillars.visuals, b.pillars.safety, b.pillars.novelty, b.pillars.coherence, b.pillars.durationFit]
  return cosine(va, vb)
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
  return (dot / denom + 1) / 2
}
