import { link, lstat, mkdir, realpath } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { HttpError } from "./http"

// A relative path inside the files root: "" is the root, segments joined by "/".
export function cleanRel(input: unknown): string {
  if (input === undefined || input === null) return ""
  if (typeof input !== "string" || input.length > 4096) throw new HttpError(400, "bad path")
  const parts = input.split("/").filter(part => part !== "")
  for (const part of parts) {
    if (part === "." || part === ".." || part.length > 255 || /[\0\\]/.test(part)) throw new HttpError(400, "bad path")
  }
  return parts.join("/")
}

export function within(root: string, path: string) {
  return path === root || path.startsWith(root + sep)
}

// The real location of an existing entry; symlinks that leave the root are rejected.
export async function resolveExisting(root: string, rel: string) {
  const path = join(root, rel)
  if (!within(root, path)) throw new HttpError(404)
  let real: string
  try {
    real = await realpath(path)
  } catch {
    throw new HttpError(404)
  }
  if (!within(await realpath(root), real)) throw new HttpError(404)
  return real
}

// The location of a new entry whose parent exists inside the root and whose name is free.
export async function resolveNew(root: string, rel: string) {
  if (!rel) throw new HttpError(400, "bad path")
  const path = join(root, rel)
  if (!within(root, path)) throw new HttpError(400, "bad path")
  const parent = await resolveExisting(root, dirname(rel) === "." ? "" : dirname(rel))
  if (!(await lstat(parent)).isDirectory()) throw new HttpError(400, "parent is not a folder")
  const target = join(parent, path.slice(path.lastIndexOf(sep) + 1))
  const exists = await lstat(target).then(() => true, () => false)
  if (exists) throw new HttpError(409, "exists")
  return target
}

// A user's own folder: it must be a real folder, never a link to another one.
export async function userRoot(library: string, userId: string) {
  const root = join(library, userId)
  if (!(await lstat(root).catch(() => null))?.isDirectory()) throw new HttpError(404)
  return root
}

// Makes root/<rel> one level at a time, each level checked before anything is
// made inside it, so a link in the path never leads a write elsewhere.
export async function ensureDir(root: string, rel: string) {
  let folder = root
  const parts = rel.split("/")
  for (let i = 1; i <= parts.length; i++) {
    const step = parts.slice(0, i).join("/")
    await mkdir(join(root, step)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    })
    folder = await resolveExisting(root, step)
  }
  return folder
}

// Links source into folder under its name, or name_1, name_2 when taken; never overwrites.
export async function linkFree(source: string, folder: string, name: string) {
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  for (let i = 0; ; i++) {
    const final = i === 0 ? name : `${stem}_${i}${ext}`
    try {
      await link(source, join(folder, final))
      return final
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || i >= 999) throw error
    }
  }
}
