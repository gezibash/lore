# KPIs and runs

## Runs

A KPI reading is one scalar over time. A run is the event behind it: what it
was given, every number it produced, and the files it left. A sweep, a
benchmark, a migration, a deploy. Without a record, that knowledge lives as
prose in a journal entry, where it cannot be compared against the run before
it.

```bash
lore run log sweep-42 \
  --param lr=0.003 --param seed=7 \
  --metric auc=0.812 \
  --artifact results/sweep-42/plot.png \
  --note "widened the search"

lore run ls --name sweep-42 --since 2w
lore run show <id>
```

`--outcome` takes `success` (the default), `failure` or `aborted`. Record a
failed run: it states a configuration that does not work, which is the thing
most often repeated by accident.

A parameter keeps its text, because its type belongs to the tool that read it.
A metric must be a number, because a value nothing can compare is not worth
storing.

Each run carries the same provenance as a KPI reading — narrative, git head,
lore commit — so a run and a reading taken from it agree on which state of the
code produced them. `lore run show` prints it.

### KPIs

Track a metric as a timeseries so each reading carries provenance — narrative, git head, lore commit — instead of living in a scratch CSV.

```bash
lore kpi log recall@10 0.518 --direction up --meta bench=httpx
lore kpi goal recall@10 0.8
lore kpi log recall@10 0.61
lore kpi status recall@10
```

The first `log` for a KPI needs `--direction up|down`. Readings attach to the sole open narrative; pass `--narrative <name>` when several are open.
