// The shapes of the SuperDB book's algebraic data model section, as a
// TypeScript sum type declared with Zod.

import * as z from "zod"

export const Shape = z
  .discriminatedUnion("type", [
    z.object({ id: z.int(), type: z.literal("Rectangle"), dimensions: z.object({ width: z.int(), height: z.int() }) }),
    z.object({ id: z.int(), type: z.literal("Circle"), dimensions: z.object({ radius: z.int() }) }),
    z.object({ id: z.int(), type: z.literal("Square"), dimensions: z.object({ side: z.int() }) }),
    z.object({ id: z.int(), type: z.literal("Vector"), dimensions: z.array(z.int()) }),
  ])
  .meta({ id: "Shape" })

// The same type the book writes by hand:
//
//   | { id: number; type: "Rectangle"; dimensions: { width: number; height: number } }
//   | { id: number; type: "Circle"; dimensions: { radius: number } }
//   | { id: number; type: "Square"; dimensions: { side: number } }
//   | { id: number; type: "Vector"; dimensions: number[] }
export type Shape = z.infer<typeof Shape>

/** The area of a shape.  TypeScript checks that every kind of shape is handled. */
export function area(shape: Shape): number {
  switch (shape.type) {
    case "Rectangle":
      return shape.dimensions.width * shape.dimensions.height
    case "Circle":
      return Math.PI * shape.dimensions.radius ** 2
    case "Square":
      return shape.dimensions.side ** 2
    case "Vector":
      return 0
  }
}
