# The daemon

A local daemon owns the job queue. Any command starts it on demand, so there is nothing to launch by hand.

```bash
lore daemon status
lore daemon logs
lore daemon stop
```

Merge closes are asynchronous by default:

```bash
lore close fix-auth-race     # returns a job ID
lore jobs                    # queued, leased, done, failed
lore job <id>
lore wait <id>
```

Use `lore close --wait` when the next step depends on the integrated concept state. `--merge-strategy` selects how the entries land:

| Strategy          | What it does to the concept body                                              |
| ----------------- | ----------------------------------------------------------------------------- |
| `patch` (default) | Rewrites only the paragraphs the entries touch. Keeps the rest word for word. |
| `extend`          | Keeps every section. Adds new sections for new topics.                        |
| `correct`         | Treats the entries as the truth. Drops a claim the entries do not support.    |
| `replace`         | Writes a new body from the entries. The old prose is gone.                    |

`patch` and `extend` cannot remove text. `correct` and `replace` can.

The daemon serves the code it was spawned with. It compares its start time against the newest `.ts` file under the workspace root and restarts itself before dispatch. A busy daemon is left alone, because a leased job holds state a restart would strand. The check applies only to a source checkout: a compiled binary carries its code inside itself, so a restart cannot make it newer. Set `LORE_DAEMON_STALE_CHECK=0` to opt out.
