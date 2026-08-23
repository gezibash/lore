import type { KpiDirection, WorkerClient } from "@lore/worker";
import { formatKpiStatusCli } from "../formatters.ts";
import { emit } from "../output.ts";

export interface KpiCreateOpts {
  direction?: KpiDirection;
  unit?: string;
  note?: string;
}

/** Parse `key=value` pairs; numeric-looking values become numbers. */
function parseKpiMeta(pairs: string[] | undefined): Record<string, unknown> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const meta: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --meta '${pair}'. Use key=value.`);
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1).trim();
    const num = Number(raw);
    meta[key] = raw !== "" && Number.isFinite(num) ? num : raw;
  }
  return meta;
}

export async function kpiLogCommand(
  client: WorkerClient,
  name: string,
  value: number,
  opts: KpiCreateOpts & { narrative?: string; meta?: string[] },
): Promise<void> {
  const result = await client.kpiLog(name, value, {
    direction: opts.direction,
    unit: opts.unit,
    note: opts.note,
    narrative: opts.narrative,
    meta: parseKpiMeta(opts.meta),
  });
  emit(result, (r) => {
    const head = r.created_kpi ? `Created KPI '${r.kpi.name}' and logged` : "Logged";
    return `${head} ${r.kpi.name} = ${r.reading.value}${r.kpi.unit ? ` ${r.kpi.unit}` : ""}\n${formatKpiStatusCli([r.kpi])}`;
  });
}

export async function kpiGoalCommand(
  client: WorkerClient,
  name: string,
  target: number,
  opts: KpiCreateOpts,
): Promise<void> {
  const result = await client.kpiGoal(name, target, opts);
  emit(result, (r) => {
    const head = r.created_kpi ? `Created KPI '${r.kpi.name}' with goal` : "Goal set:";
    return `${head} ${r.kpi.name} → ${r.kpi.goal}${r.kpi.unit ? ` ${r.kpi.unit}` : ""}\n${formatKpiStatusCli([r.kpi])}`;
  });
}

export async function kpiStatusCommand(
  client: WorkerClient,
  name: string | undefined,
  limit: number | undefined,
): Promise<void> {
  const result = await client.kpiStatus({ name, limit });
  emit(result, (kpis) => formatKpiStatusCli(kpis, { history: Boolean(name) }));
}
