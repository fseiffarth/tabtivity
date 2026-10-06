# Performance plan — handoff

*One section per agent step of [`performance_plan.md`](performance_plan.md)
§11. Each step's implementer appends its own section; its reviewer appends a
"Review" subsection. Nothing here was run live unless a section says so.
Worktree: `.claude/worktrees/perf`, branch `perf`, created from `develop` at
`a6ed2c7a`.*

Section template:

```
## S<n> — <title>

*Written <date> by the S<n> implementer. Base `<sha>`. Nothing run live.*

### Commits
| Commit | Content |

### What was built / choices made
### Gotchas for later steps
### Gates (worktree)
| Gate | Result (with test counts) |
### Flagged for user
### Live click-through (user)

### Review (S<n> reviewer, <date>)
- range reviewed, bugs fixed (sha + regression test), gates after, flagged
```
