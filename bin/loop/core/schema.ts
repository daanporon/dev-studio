// schema.ts — a tiny payload-shape language for kinds.ts (U43). A shape checks a value at run time
// (`check` returns null or a message naming the field) and carries the TypeScript type it describes,
// so one definition gives both the store's write check and the fulfillers' payload type.
//
//   const keys = obj({ text: str, enter: opt(bool) });   // { text: string; enter?: boolean | null }
//   type Keys = Val<typeof keys>;
//
// Objects accept extra fields (a request carries `from`, `cwd` and the like); only the fields a shape
// names are checked. A null or missing value is an empty object, so an all-optional shape takes none.

export interface Shape<V = unknown> {
  readonly name: string;
  check(v: unknown, path: string): string | null;
  /** phantom: the TypeScript type of a value that passes `check` */
  readonly _v?: V;
}
export interface OptShape<V = unknown> extends Shape<V | undefined> { readonly optional: true; readonly inner: Shape<V> }
export type Val<S> = S extends Shape<infer V> ? V : never;

const kindOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`);
const prim = <V>(name: string, ok: (v: unknown) => boolean): Shape<V> => ({ name, check: (v, path) => (ok(v) ? null : `${path} must be ${name}, got ${kindOf(v)}`) });

export const str: Shape<string> = prim("a string", (v) => typeof v === "string");
export const num: Shape<number> = prim("a number", (v) => typeof v === "number" && Number.isFinite(v));
export const bool: Shape<boolean> = prim("a boolean", (v) => typeof v === "boolean");
export const any: Shape<unknown> = { name: "any value", check: () => null };
export const rec: Shape<Record<string, unknown>> = prim("an object", (v) => typeof v === "object" && v !== null && !Array.isArray(v));

export function opt<V>(inner: Shape<V>): OptShape<V> {
  return { name: `${inner.name} or absent`, optional: true, inner, check: (v, path) => (v === undefined || v === null ? null : inner.check(v, path)) };
}
export function arr<V>(of: Shape<V>): Shape<V[]> {
  return { name: "an array", check: (v, path) => {
    if (!Array.isArray(v)) return `${path} must be an array, got ${kindOf(v)}`;
    for (let i = 0; i < v.length; i++) { const m = of.check(v[i], `${path}[${i}]`); if (m) return m; }
    return null;
  } };
}
export function lit<L extends string>(...vals: L[]): Shape<L> {
  return { name: `one of ${vals.join("|")}`, check: (v, path) => (typeof v === "string" && (vals as string[]).includes(v) ? null : `${path} must be one of ${vals.join("|")}, got ${JSON.stringify(v)}`) };
}
export function either<A, B>(a: Shape<A>, b: Shape<B>): Shape<A | B> {
  return { name: `${a.name} or ${b.name}`, check: (v, path) => (a.check(v, path) === null || b.check(v, path) === null ? null : `${path} must be ${a.name} or ${b.name}, got ${kindOf(v)}`) };
}

type Fields = Record<string, Shape<any>>;
type OptKeys<F extends Fields> = { [K in keyof F]: F[K] extends OptShape<any> ? K : never }[keyof F];
type Flat<T> = { [K in keyof T]: T[K] };
export type ObjVal<F extends Fields> = Flat<{ [K in Exclude<keyof F, OptKeys<F>>]: Val<F[K]> } & { [K in OptKeys<F>]?: F[K] extends OptShape<infer V> ? V : never }>;
export interface ObjShape<F extends Fields> extends Shape<ObjVal<F>> { readonly fields: F }

export function obj<F extends Fields>(fields: F): ObjShape<F> {
  return { name: "an object", fields, check(v, path) {
    if (v === undefined || v === null) v = {};
    if (typeof v !== "object" || Array.isArray(v)) return `${path} must be an object, got ${kindOf(v)}`;
    for (const [k, s] of Object.entries(fields)) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined && !("optional" in s)) return `${path}.${k} is required`;
      const m = s.check(x, `${path}.${k}`);
      if (m) return m;
    }
    return null;
  } };
}
