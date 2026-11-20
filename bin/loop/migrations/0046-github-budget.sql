-- U286: the GitHub GraphQL budget on the observer's schedule row (observed_github, repo ''), next to
-- `cost` and `remaining`: the hourly `rate_limit` (GraphQL's rateLimit.limit; `limit` is a keyword)
-- and `reset_at` (epoch seconds, rateLimit.resetAt, or `gh api rate_limit` after a refusal).
-- bin/loop/io/github-budget.ts reads them; the merge fulfiller waits for reset_at.
ALTER TABLE observed_github ADD COLUMN rate_limit INTEGER;
ALTER TABLE observed_github ADD COLUMN reset_at INTEGER;
