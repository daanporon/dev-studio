// fulfil/role.ts — kind `reassert-roles`: the request reassert-roles.sh writes. The loop runs
// the script again with DS_LOOP_CHILD=1 (replay.ts).
// U159: the member-wish replay is gone. A member wish is a plain wish the decider acts on in
// Bun (fulfil/member.ts); a pre-U159 one still carrying a script replay is treated as a plain
// wish too, never run as a child.
import { requests } from "../messages/replay.ts";

export default requests("role", ["reassert-roles"]);
