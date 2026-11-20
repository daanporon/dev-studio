-- 0006-u14-config-comment.sql — a config row keeps its line's trailing `# comment`: the board's
-- Settings tab shows it as each limit's help text, and the board reads config only from rows.
ALTER TABLE config ADD COLUMN comment TEXT;
