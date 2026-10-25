import { lstat, realpath } from "node:fs/promises"
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
