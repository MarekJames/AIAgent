export type Pillars = {
  hook: number;
  watchability: number;
  visuals: number;
  safety: number;
  novelty: number;
  coherence: number;
  durationFit: number;
};

export type RankInput = {
  id: string;
  videoId: string;
  start: number;
  end: number;
  score: number;
  pillars: Pillars;
  aiOverall?: number;
  durationChoice?: "t60" | "t120";
  nearHotspot?: boolean;
};

export type RankOutput = RankInput & {
  rankScore: number;
  tier: "S" | "A" | "B";
  reasons: string[];
};

function clamp01(v: number): number {
  if (v < 0) {
    return 0;
  }
  if (v > 1) {
    return 1;
  }
  return v;
}

function gmean(xs: number[]): number {
  let p = 1;
  let k = 0;
  for (const x of xs) {
    p = p * clamp01(x);
    k = k + 1;
  }
  if (k === 0) {
    return 0;
  }
  return Math.pow(p, 1 / k);
}

function curve(x: number, difficulty: number): number {
  const d = clamp01(difficulty);
  const a = 4 * d;
  const y = 1 / (1 + Math.exp(-a * (x - 0.5)));
  return clamp01(y);
}

function normalize(xs: number[]): number[] {
  if (xs.length === 0) {
    return [];
  }
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  if (max === min) {
    return xs.map(() => 0.5);
  }
  return xs.map((v) => (v - min) / (max - min));
}

export function rankClips(inputs: RankInput[]): RankOutput[] {
  const baseScores = inputs.map((x) => x.score);
  const baseN = normalize(baseScores);
  const out: RankOutput[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const it = inputs[i];
    const p = it.pillars;
    const base = baseN[i];
    const hook = p.hook;
    const watch = p.watchability;
    const viz = p.visuals;
    const coh = p.coherence;
    const dur = p.durationFit;
    const safe = p.safety;
    const nov = p.novelty;
    const ai = it.aiOverall === undefined ? 0.5 : clamp01(it.aiOverall / 100);
    const blend = gmean([base, hook, watch, viz, coh, dur, safe, nov]);
    const withAi = clamp01(0.7 * blend + 0.3 * ai);
    const hotspotBoost = it.nearHotspot ? 0.04 : 0;
    const durBias = it.durationChoice === "t120" ? 0.02 : 0;
    const raw = clamp01(withAi + hotspotBoost + durBias);
    const curved = curve(raw, 0.92);
    const rankScore = curved;
    let tier: "S" | "A" | "B" = "B";
    if (rankScore >= 0.78) {
      tier = "S";
    } else if (rankScore >= 0.62) {
      tier = "A";
    }
    const reasons: string[] = [];
    if (hook > 0.72) {
      reasons.push("hook");
    }
    if (watch > 0.68) {
      reasons.push("retention");
    }
    if (coh > 0.7) {
      reasons.push("coherence");
    }
    if (dur > 0.85) {
      reasons.push("duration-fit");
    }
    if (nov > 0.6) {
      reasons.push("novelty");
    }
    if (it.nearHotspot) {
      reasons.push("audience-hotspot");
    }
    out.push({ ...it, rankScore, tier, reasons });
  }
  out.sort(
    (a, b) =>
      b.rankScore - a.rankScore || (a.durationChoice === "t120" ? -1 : 1)
  );
  return out;
}
