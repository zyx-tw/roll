// Places: GeoNames cities1000 (every town over 1000 people, with names in many
// languages) turns a photo's GPS into its nearest town, and a typed name
// ("京都", "Kyoto", "日本") back into towns or a country. Off when the file is missing.
import { existsSync, readFileSync } from "node:fs"

type Town = { id: number; label: string; country: string; lat: number; lon: number }

// Beyond this a photo has no town (sea, sky, wilderness).
const MAX_KM = 40
const SUFFIX = /(市|区|區|町|村|県|縣|郡|鎮|镇|鄉|乡)$/

export const normalize = (text: string) => text.normalize("NFKC").trim().toLowerCase()

// Country names in the languages people here type, by ISO code.
function countryNames() {
  const out = new Map<string, string>()
  const display = ["zh-Hant", "zh-Hans", "ja", "en", "ko"].map(lang => new Intl.DisplayNames([lang], { type: "region" }))
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  for (const a of letters)
    for (const b of letters) {
      const code = a + b
      for (const names of display) {
        const name = names.of(code)
        if (name && name !== code) out.set(normalize(name), code)
      }
    }
  // Common short forms.
  for (const [name, code] of [["台灣", "TW"], ["台湾", "TW"], ["美國", "US"], ["美国", "US"], ["英國", "GB"], ["韓國", "KR"]]) out.set(name, code)
  return out
}

export function loadPlaces(path: string) {
  const towns = new Map<number, Town>()
  const grid = new Map<string, Town[]>()
  const byName = new Map<string, Set<number>>()
  const countries = countryNames()

  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue
      const f = line.split("\t")
      const id = Number(f[0])
      const alts = f[3] ? f[3].split(",") : []
      // The shortest name written in Han characters reads best here (京都, 大阪).
      const han = alts.filter(name => /^\p{Script=Han}+$/u.test(name)).sort((a, b) => a.length - b.length)[0]
      const town: Town = { id, label: han ?? f[1], country: f[8], lat: Number(f[4]), lon: Number(f[5]) }
      towns.set(id, town)
      const cell = `${Math.floor(town.lat)},${Math.floor(town.lon)}`
      if (!grid.has(cell)) grid.set(cell, [])
      grid.get(cell)!.push(town)
      // Index the main name and names in Han, kana or Hangul; the other
      // languages' spellings would cost hundreds of MB for little use here.
      for (const name of [f[1], f[2], ...alts.filter(name => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(name))]) {
        const key = normalize(name)
        if (!key) continue
        for (const k of new Set([key, key.replace(SUFFIX, "")])) {
          if (!k) continue
          if (!byName.has(k)) byName.set(k, new Set())
          byName.get(k)!.add(id)
        }
      }
    }
  }

  // The nearest town within MAX_KM, searching the 3 x 3 one-degree cells around.
  function nearest(lat: number, lon: number): Town | null {
    let best: Town | null = null
    let bestKm = MAX_KM
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const town of grid.get(`${Math.floor(lat) + dy},${Math.floor(lon) + dx}`) ?? []) {
          const x = (town.lon - lon) * Math.cos(((lat + town.lat) / 2) * (Math.PI / 180))
          const km = Math.hypot(x, town.lat - lat) * 111.2
          if (km < bestKm) {
            best = town
            bestKm = km
          }
        }
      }
    return best
  }

  return {
    ready: towns.size > 0,
    nearest,
    label: (id: number | null) => (id === null ? null : (towns.get(id)?.label ?? null)),
    towns: (name: string) => [...(byName.get(normalize(name)) ?? [])],
    country: (name: string) => countries.get(normalize(name)) ?? null,
  }
}

export type Places = ReturnType<typeof loadPlaces>
