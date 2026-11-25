// attach-line.ts — the command a person runs to reach an agent on a backend that has no `focus` or
// `terminal-switch` verb (orca-backend-alternatives U58): `ds team --switch` prints it for a member off Orca.
import { herdrBin } from "../backend/herdr-bin.ts";
import { herdrPlace } from "../backend/herdr.ts";

/** How to reach terminal `id` (a backend's handle; "" when no live one is seen) of a member of `project` that runs
 *  in folder `path` on `backend`. */
export function attachLine(backend: string, project: string, root: string, id: string, path: string): string {
  if (backend === "tmux") {
    const sock = `tmux -L ds-${project.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
    return id ? `${sock} attach -t ${id} \\; select-window -t ${id} \\; select-pane -t ${id}` : `${sock} attach`;
  }
  if (backend === "herdr") {
    const h = herdrPlace(root, project);
    return `HERDR_SOCKET_PATH=${h.socket} HERDR_SESSION=${h.session} ${herdrBin() ?? "herdr"}${id ? `   (terminal ${id})` : ""}`;
  }
  if (backend === "orca-lite") return `open ${path} in the Orca UI${id ? ` (terminal ${id})` : ""}`;
  return `attach to ${path}${id ? ` (terminal ${id})` : ""} on ${backend}`;
}
