# Agent instructions

Be extremely concise. Avoid tautological tests.

## Product intent

`agvid` helps coding agents inspect video without loading every full-resolution frame into context. It is a local npm CLI backed by FFmpeg and FFprobe. Keep output files and machine-readable manifests easy for agents to find and relate to source timestamps.

The main workflow is progressive:

1. Run `agvid probe video.mov` to see duration, dimensions, frame rate, and codec when source size matters.
2. Run `agvid overview video.mov` for evenly spaced frames and labeled sheets. The default is 12 frames.
3. Run `agvid changes video.mov` on screen recordings to find moments where the picture changes. Use `--start/--end` on long videos and `--crop` for small UI changes.
4. Run `agvid inspect video.mov --around 00:07.5 --window 2s --fps 4` to inspect motion near a moment. The window is the total centered duration and clips to video bounds. `--start/--end` inspects a range instead.
5. Run `agvid frame video.mov --at 00:07.5` when one exact moment is enough. `--at` and `--around` accept several values in one call.
6. Add `--crop x,y,w,h` (fractions of the displayed frame) to zoom into a region on any image command.

`--width` caps extracted frame width and defaults to 640 pixels. Preserve aspect ratio. Output JPEG frames plus `manifest.json`, which maps filenames to source times. Overview, inspect and changes also write sheets, and frame does when given several `--at` times. `--output` chooses an output directory; otherwise create a fresh directory under `.agvid/runs/` in the git root (else cwd).

## Development boundaries

- Keep the CLI dependency free where practical. FFmpeg and FFprobe are explicit runtime prerequisites.
- Validate arguments and cap accidental large extraction jobs before running FFmpeg.
- Keep timestamps in the manifest tied to the requested source positions. A frame is evidence for a moment, not a promise of frame accurate seeking across all codecs.
- Keep the installable agent skill in `skill/agvid/SKILL.md` aligned with the actual CLI. Package it in npm releases.
- Verify behavior with a real short video fixture or generated test video. Avoid tests that merely mirror argument parsing or string literals.
- Do not add CI or CD configuration unless requested.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
