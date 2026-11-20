# shellcheck shell=bash
# shellcheck disable=SC2034  # the variables are used by the part that sources this
# review-unit-proof-repo.sh — sourced by the review-unit parts that run after the independent proof cases (U233): the
# unrelated repo ($RP, base branch trunk, unit branch feature) and its helpers, as tests/review-unit-proof.sh builds them.
# Proof is project agnostic: no dev-studio or ACME files, with a different base branch.
RP="$TMP/independent"; PF="$RP/.git/ds-review"; PB="$RP/.git/ds-review-base"
gp() { git -C "$RP" -c user.email=t@t -c user.name=t "$@"; }
proof_run() { (cd "$RP" && clear_last_run && "$RU" "$LBL" "$@") >"$TMP/proof-out" 2>"$TMP/err"; }
git init -q -b trunk "$RP"; echo base > "$RP/file"; gp add file; gp commit -q -m base
gp checkout -q -b feature; echo unit >> "$RP/file"; gp commit -q -am unit
# U267: a project roster overrides per role, so each one below sets builder-review-standard to its
# builder-review row too (sed), or an untiered unit would review on the default's standard row.
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
mkdir -p "$SD"
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
mbase="$(gp merge-base trunk HEAD)"
