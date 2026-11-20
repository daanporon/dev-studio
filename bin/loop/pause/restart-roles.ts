const roles = new Set(["lead", "thinker", "builder", "tester", "reviewer", "researcher"]);

export function canRestartRole(role: unknown): boolean {
  return typeof role === "string" && roles.has(role);
}
