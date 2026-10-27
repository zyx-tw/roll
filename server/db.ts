import { Database } from "bun:sqlite"

export type User = {
  id: string
  name: string
  created_at: number
  // "upload" for a session that may only send files; null for a full session.
  scope?: string | null
}

export type Credential = {
  id: string
  user_id: string
  public_key: Uint8Array
  counter: number
  transports: string | null
  created_at: number
}

export type Photo = {
  id: string
  user_id: string
  path: string
  size: number
  mtime: number
  kind: "image" | "video"
  taken_at: number
  width: number
  height: number
  duration: number | null
  lat: number | null
  lon: number | null
  live_path: string | null
  place_id: number | null
  country: string | null
  status: "ready" | "failed"
  version: number
}

export function openDb(path: string) {
  const db = new Database(path, { create: true, strict: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(`
    create table if not exists users (
      id text primary key,
      name text not null,
      created_at integer not null
    );
    create table if not exists credentials (
      id text primary key,
      user_id text not null references users(id),
      public_key blob not null,
      counter integer not null,
      transports text,
      created_at integer not null
    );
    create table if not exists sessions (
      token_hash text primary key,
      user_id text not null references users(id),
      created_at integer not null,
      expires_at integer not null
    );
    create table if not exists invites (
      token_hash text primary key,
      user_id text not null references users(id),
      created_at integer not null,
      expires_at integer not null,
      used_at integer
    );
    create table if not exists photos (
      id text primary key,
      user_id text not null references users(id),
      path text not null,
      size integer not null,
      mtime integer not null,
      kind text not null,
      taken_at integer not null,
      width integer not null,
      height integer not null,
      duration real,
      lat real,
      lon real,
      live_path text,
      status text not null,
      version integer not null,
      unique (user_id, path)
    );
    create index if not exists photos_timeline on photos(user_id, status, taken_at desc, id desc);
  `)
  // Added after launch: the nearest town and its country.
  const columns = new Set((db.query("pragma table_info(photos)").all() as { name: string }[]).map(c => c.name))
  if (!columns.has("place_id")) db.exec("alter table photos add column place_id integer")
  if (!columns.has("country")) db.exec("alter table photos add column country text")
  db.exec("create index if not exists photos_place on photos(user_id, place_id)")
  // "upload" sessions (from the iOS app) may only send files; null is a full session.
  const sessionColumns = new Set((db.query("pragma table_info(sessions)").all() as { name: string }[]).map(c => c.name))
  if (!sessionColumns.has("scope")) db.exec("alter table sessions add column scope text")
  // Search by meaning: one row per photo version that was read, and its
  // vectors (one for a photo, a few frames for a video). front and screenshot
  // come from the original's EXIF; text is what OCR read, text_key the same
  // for matching (NFKC, lower case, no spaces).
  db.exec(`
    create table if not exists photo_index (
      photo_id text primary key references photos(id) on delete cascade,
      user_id text not null,
      version integer not null,
      model text not null,
      front integer not null default 0,
      screenshot integer not null default 0,
      text text not null default '',
      text_key text not null default '',
      error text,
      indexed_at integer not null
    );
    create index if not exists photo_index_user on photo_index(user_id);
    create table if not exists photo_vectors (
      photo_id text not null references photos(id) on delete cascade,
      frame integer not null,
      vector blob not null,
      primary key (photo_id, frame)
    );
  `)
  // Faces: found once per photo version (face_scans), named by the user. A
  // person belongs to one user. labeled_by is "user" when the user decided
  // (a person, or person_id null for "not someone to name"), "auto" when
  // matched to a face the user named, null when nobody decided.
  db.exec(`
    create table if not exists persons (
      id integer primary key autoincrement,
      user_id text not null references users(id),
      name text not null,
      created_at integer not null,
      unique (user_id, name)
    );
    create table if not exists faces (
      id text primary key,
      photo_id text not null references photos(id) on delete cascade,
      user_id text not null,
      box text not null,
      score real not null,
      vector blob not null,
      person_id integer references persons(id) on delete set null,
      labeled_by text,
      created_at integer not null
    );
    create index if not exists faces_photo on faces(photo_id);
    create index if not exists faces_user on faces(user_id, person_id);
    create table if not exists face_scans (
      photo_id text primary key references photos(id) on delete cascade,
      version integer not null,
      model text not null
    );
  `)
  // A title and a description the user gives a photo; a scan seeds them once
  // from the file's own (XMP, IPTC, QuickTime) and never overwrites the user's.
  // text_key is both, for matching search words (library.ts noteKey).
  db.exec(`
    create table if not exists photo_notes (
      photo_id text primary key references photos(id) on delete cascade,
      user_id text not null,
      title text not null default '',
      description text not null default '',
      text_key text not null default '',
      updated_at integer not null
    );
    create index if not exists photo_notes_user on photo_notes(user_id);
  `)
  return db
}

export type Db = ReturnType<typeof openDb>
