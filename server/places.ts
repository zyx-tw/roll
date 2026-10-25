// Places: GeoNames cities1000 (every town over 1000 people, with names in many
// languages) turns a photo's GPS into its nearest town, and a typed name
// ("京都", "Kyoto", "日本") back into towns or a country. Off when the file is missing.
import { existsSync, readFileSync } from "node:fs"

type Town = { id: number; label: string; han: boolean; country: string; lat: number; lon: number; population: number }

// Beyond this a photo has no town (sea, sky, wilderness).
const MAX_KM = 40

// How far a town's name reaches: a village 3 km, Kyoto about 20 km, a
// metropolis at most 25 km. Wards and districts fall inside their city.
export const reachKm = (population: number) => Math.min(25, Math.max(3, 2 + Math.sqrt(population) / 60))

const km = (aLat: number, aLon: number, bLat: number, bLon: number) =>
  Math.hypot((bLon - aLon) * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180)), bLat - aLat) * 111.2
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
      const town: Town = { id, label: han ?? f[1], han: han !== undefined, country: f[8], lat: Number(f[4]), lon: Number(f[5]), population: Number(f[14]) || 0 }
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

  // A photo's town, as people here would name it: the nearest town of 50,000
  // or more whose reach covers the spot (Namba reads 大阪, Uji 宇治), else the
  // nearest town with a Han name (a ward like Kamigyō-ku has none), else the
  // nearest town of any name.
  function nearest(lat: number, lon: number): Town | null {
    const best = { city: [null, MAX_KM], named: [null, MAX_KM], any: [null, MAX_KM] } as Record<string, [Town | null, number]>
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const town of grid.get(`${Math.floor(lat) + dy},${Math.floor(lon) + dx}`) ?? []) {
          const d = km(lat, lon, town.lat, town.lon)
          if (d < best.any[1]) best.any = [town, d]
          if (town.han && d < best.named[1]) best.named = [town, d]
          if (town.han && town.population >= 50_000 && d <= reachKm(town.population) && d < best.city[1]) best.city = [town, d]
        }
      }
    return best.city[0] ?? best.named[0] ?? best.any[0]
  }

  // Towns a word names, biggest first, at most 20.
  function named(name: string) {
    return [...(byName.get(normalize(name)) ?? [])]
      .map(id => towns.get(id)!)
      .sort((a, b) => b.population - a.population)
      .slice(0, 20)
  }

  return {
    ready: towns.size > 0,
    nearest,
    label: (id: number | null) => (id === null ? null : (towns.get(id)?.label ?? null)),
    towns: (name: string) => named(name).map(town => town.id),
    // Boxes around each named town, as far as its name reaches.
    areas: (name: string) =>
      named(name).map(town => {
        const dLat = reachKm(town.population) / 111.2
        const dLon = dLat / Math.max(0.01, Math.cos(town.lat * (Math.PI / 180)))
        return { minLat: town.lat - dLat, maxLat: town.lat + dLat, minLon: town.lon - dLon, maxLon: town.lon + dLon }
      }),
    country: (name: string) => countries.get(normalize(name)) ?? null,
  }
}

export type Places = ReturnType<typeof loadPlaces>
