import { Database } from "bun:sqlite"

export type User = {
  id: string
  name: string
  created_at: number
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
  return db
}

export type Db = ReturnType<typeof openDb>
