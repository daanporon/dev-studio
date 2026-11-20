// Deliberately wrong: `keys` needs a string `text`. tests/typecheck.sh must see tsc fail on this file.
import { open } from "../../bin/loop/core/store.ts";

const s = open("/nonexistent");
s.request("keys", { text: 5 }, {});
s.request("no-such-kind", {}, {});
