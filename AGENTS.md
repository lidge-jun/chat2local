# chat2local agent rules

- Treat ChatGPT as the planner; batch execution is not a nested coding agent.
- Never run install, build, typecheck, tests, generated JavaScript, or shell probes on a connected personal/dogfooding host. Validate in an isolated environment or hosted CI.
- Never read or change real authentication files, browser profiles, keychains, service configuration, or credentials. A new worktree or HOME variable is not a sandbox.
- Keep host shell execution disabled. Code mode must fail closed without its disposable worker; do not add eval/vm/worker-thread host fallbacks.
- Preserve local changes. Check status before edits; use [agent] commit prefixes and --no-verify for explicitly requested commits/pushes. Never force-push or touch the parent repository.
- Document implemented capabilities and verified checks separately from planned features and untested integrations. Do not invent speedup claims.
- Keep AGENTS.md and SKILL.md in English; user documentation is Korean, narrative-first.
