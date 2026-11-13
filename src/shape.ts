// Helpers for laying out values of a record type as table columns.

import { type Type, recordOf } from "./types.ts"

export interface Column {
  /** Field names from the root record to this column. */
  path: string[]
  /** Field positions from the root record to this column (see RecordValue.fieldAt). */
  indexPath: number[]
  /** The type of the column's values. */
  type: Type
  /** Child columns if the column is a nested record, otherwise null. */
  children: Column[] | null
}

/**
 * The columns of a shape.  A record type yields a column per field (with
 * nested records as columns that have children); any other type yields a
 * single column named "this".
 */
export function columnsOf(shape: Type): Column[] {
  const rec = recordOf(shape)
  if (!rec) return [{ path: ["this"], indexPath: [], type: shape, children: null }]
  return fieldColumns(shape, [], [])
}

function fieldColumns(typ: Type, path: string[], indexPath: number[]): Column[] {
  const rec = recordOf(typ)
  if (!rec) return []
  return rec.fields.map((f, k) => {
    const p = [...path, f.name]
    const ip = [...indexPath, k]
    const nested = recordOf(f.type)
    return { path: p, indexPath: ip, type: f.type, children: nested ? fieldColumns(f.type, p, ip) : null }
  })
}

/** The leaf columns of a shape, with nested records flattened. */
export function leafColumnsOf(shape: Type): Column[] {
  const out: Column[] = []
  const walk = (cols: Column[]) => {
    for (const c of cols) {
      if (c.children && c.children.length > 0) walk(c.children)
      else out.push(c)
    }
  }
  walk(columnsOf(shape))
  return out
}
