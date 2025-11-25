export type Taxonomy = { category: string; hookType: 'question' | 'bold' | 'number' | 'contrast' | 'statement' | 'story'; tone: 'educational' | 'motivational' | 'humor' | 'commentary' | 'news' | 'tech' | 'finance' | 'health' | 'sports' | 'other' }

export function inferTaxonomy(text: string, hook: string, gptCategory?: string): Taxonomy {
  const h = hook.toLowerCase()
  let hookType: Taxonomy['hookType'] = 'statement'
  if (/\?/.test(h) || /^(how|why|what|when|where|who|can|should|would)\b/i.test(h)) { hookType = 'question' }
  else if (/\b\d+\b/.test(h)) { hookType = 'number' }
  else if (/(vs\.|versus|compared to)/i.test(h)) { hookType = 'contrast' }
  else if (/(secret|truth|never|always|stop|must|best|worst)/i.test(h)) { hookType = 'bold' }
  let tone: Taxonomy['tone'] = 'other'
  const t = (gptCategory || '').toLowerCase()
  if (/(education|tech|tutorial)/.test(t)) { tone = 'educational' }
  else if (/motivation/.test(t)) { tone = 'motivational' }
  else if (/humor|comedy/.test(t)) { tone = 'humor' }
  else if (/commentary|opinion/.test(t)) { tone = 'commentary' }
  else if (/news/.test(t)) { tone = 'news' }
  else if (/tech/.test(t)) { tone = 'tech' }
  else if (/finance/.test(t)) { tone = 'finance' }
  else if (/health/.test(t)) { tone = 'health' }
  else if (/sport/.test(t)) { tone = 'sports' }
  const category = gptCategory || 'Other'
  return { category, hookType, tone }
}
