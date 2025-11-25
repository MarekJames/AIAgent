import { RankInput, RankOutput, rankClips } from '../scoring/clipRanker'

export function finalizeBestClips(inputs: RankInput[], maxClips: number = 5): RankOutput[] {
  const ranked = rankClips(inputs)
  const t60 = ranked.filter(r => r.durationChoice === 't60')
  const t120 = ranked.filter(r => r.durationChoice === 't120')
  const out: RankOutput[] = []
  const q120 = Math.min(4, Math.ceil(maxClips * 0.33))
  const q60 = maxClips - q120
  for (let i = 0; i < t120.length && out.length < q120; i++) { out.push(t120[i]) }
  for (let i = 0; i < t60.length && out.length < maxClips; i++) { out.push(t60[i]) }
  if (out.length < maxClips) {
    const rest = ranked.filter(r => !out.find(x => x.id === r.id))
    for (let i = 0; i < rest.length && out.length < maxClips; i++) { out.push(rest[i]) }
  }
  return out.slice(0, maxClips)
}
