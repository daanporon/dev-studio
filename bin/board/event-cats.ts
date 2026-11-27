// event-cats.ts — the event log's categories and noise kinds, one table (event-log-filters U1).
// The label each row carries (`cat`, CAT_SQL) and the `cat=` filter (catWhere) are both made from
// it, so they can never disagree. A kind no category lists is 'other'; tests/loop/board-events-api.test.ts
// fails when a kind seen on the live log or a FACTS key (bin/loop/core/kinds.ts) lands there.

// [key, label, kinds]: in display order. Kinds are plain [a-z0-9_-] names (checked below), so the
// SQL built from them needs no quoting beyond the single quotes.
export const CATS: readonly (readonly [string, string, string])[] = [
  ["work", "Work", "squad_start unit_builder_moved unit_dispatched unit_done finish_recorded unit_waiting squad_all_done squad_reimported squad_run squad_suspended squad_task question_answered question_dropped question_reopened question_replied question_reply_refused question_unit_linked pr_question_asked permission_asked tester_pass_done verification_admission verification_wait dependency_wait_released owner_dependency_resolved ready_deferred ready_unapproved builder_wish_withdrawn builder_wish_settled plan_revoked parked unit_cancelled_builder_started units_held_for_revalidation unit-status unit_lane_moved"],
  ["crew", "Crew", "member_account member_avoid member_closed member_drift_cleared member_phase member_placed member_rebound member_record member_requested member_start_failed member_started member_stopped member_suspended member_unbound member_waiting pick worker_stopped stray_terminal_closed duplicate_agent_closed coordinator coordinator_rebound studio_adopted wt_parent_set pause_checkpoint pause_cleared pause_closed pause_requested pause_resume_finished pause_resumed stop_checkpoint member_rebound_settled member_rebind_gave_up member_rebind_settle_gave_up member_told fallback_missed studio_moved studio_move_approved studio_move_failed studio_released"],
  ["messages", "Messages", "message_sent message_delivered message_read message_replied run_mail_given_up run_mail_relayed run_mail_resent run_mail_superseded delivery_escalated delivery_sent delivery_verified toast"],
  ["actions", "Actions", "action action_done action_dropped action_failed action_pending action_unhandled request request_done request_settled orca_call_settled refusal request_rejected"],
  ["wishes", "Wishes & reloads", "want wish wish_done wish_dropped wish_failed wish_given_up wish_reopened wish_seeded reload_ack override_cleared override_set focus_set cleared cancel_wish_cleared wish_expired"],
  ["accounts", "Accounts & limits", "account_credits_held account_disabled account_enabled account_limit_corrected account_limit_lifted limited limit_cleared limit_wait github_rate_limited queued_given_up account_reset_used account_credits_cleared account_login_ended account_login_cleared limit_expired account_added account_moved"],
  ["merges", "Merges", "auto_merge_armed auto_merge_poke_failed pr_branch_updated pr_branch_update_failed unit_pr unit_pr_blocked unit_into_merged github_error gh_cache_cleared pr_read_alerted pr_read_failing pr_read_recovered"],
  ["loop", "Loop & host", "update_run project_removed project_remove_failed shadow_started shadow_disagree shadow_explained shadow_crash feedback_drafted feedback_imported feedback_noted feedback_posting feedback_filed feedback_edited feedback_dismissed feedback_restored feedback_fixed feedback_closed host_join_requested host_join_expired host_accepted host_rejected host_removed host_link_up host_link_down host_link_closed host_link_refused side_pushed side_push_failed side_fenced side_skills_installed side_skills_failed worktree_created worktree_removed worktree_gone service_failed service_restarted service_started service_starting service_stopped loop_exit loop_code_changed loop_restart cleanup_removed cleanup_stopped leftover_dropped leftover_removed leftover_procs_stopped leftover_recorded claude_tmp_removed tick_slow spend settings_migrated host_migrated briefing_schedule plugin_error exposed unexposed replay_path_moved squad_state claude_tmp_kept cleanup_failed cleanup_on_close_ran tick_error loop_skip squad_export_kept"],
];
export const OTHER = "other";

// Routine bookkeeping the page hides unless "show noise" is on or the exact-event picker names the kind.
export const NOISE: readonly string[] = "tick_slow spend reload_ack claude_tmp_removed cleanup_removed leftover_recorded leftover_dropped wish".split(" ");

const KINDS_OF = new Map(CATS.map(([key, , kinds]) => [key, kinds.split(" ")]));
const ALL = [...KINDS_OF.values()].flat();
for (const k of [...ALL, ...NOISE]) if (!/^[a-z0-9_-]+$/.test(k)) throw new Error(`event-cats: bad kind ${k}`);
if (new Set(ALL).size !== ALL.length) throw new Error("event-cats: a kind is listed twice");

export const sqlList = (ks: readonly string[]) => ks.map((k) => `'${k}'`).join(", ");

// The category of a row, as SQL (`… AS cat`): every listed kind's key, else 'other'.
export const CAT_SQL = `(CASE ${CATS.map(([key, , kinds]) => `WHEN kind IN (${sqlList(kinds.split(" "))}) THEN '${key}'`).join(" ")} ELSE '${OTHER}' END)`;

// The category of one kind, in code (the same table).
export function catOf(kind: string): string {
  for (const [key, kinds] of KINDS_OF) if (kinds.includes(kind)) return key;
  return OTHER;
}

export const isCat = (key: string) => key === OTHER || KINDS_OF.has(key);

// The `cat=<key>` filter as one WHERE clause: `kind IN (…)`, or for 'other' every kind not listed.
// A kind list (not `CAT_SQL = ?`) so the planner can use the kind indexes. Unknown key: null.
export function catWhere(key: string): string | null {
  if (key === OTHER) return `kind NOT IN (${sqlList(ALL)})`;
  const kinds = KINDS_OF.get(key);
  return kinds ? `kind IN (${sqlList(kinds)})` : null;
}

// The kinds of one category (empty for 'other' and an unknown key: 'other' is "not listed").
export const catKinds = (key: string): string[] => [...(KINDS_OF.get(key) ?? [])];

// The categories for the type picker, in order, Other last.
export const catList = () => [...CATS.map(([key, label]) => ({ key, label })), { key: OTHER, label: "Other" }];
