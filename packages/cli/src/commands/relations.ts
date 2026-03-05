import type { WorkerClient } from "@lore/worker";
import { formatConceptRelationsCli } from "../formatters.ts";

export async function relationsSetCommand(
  client: WorkerClient,
  fromConcept: string,
  toConcept: string,
  relationType: "depends_on" | "constrains" | "implements" | "uses" | "related_to",
  weight?: number,
): Promise<void> {
  const result = client.setConceptRelation(fromConcept, toConcept, relationType, { weight });
  console.log(
    `Set relation ${result.from_concept} -${result.relation_type}-> ${result.to_concept} (w=${result.weight.toFixed(2)})`,
  );
}

export async function relationsUnsetCommand(
  client: WorkerClient,
  fromConcept: string,
  toConcept: string,
  relationType?: "depends_on" | "constrains" | "implements" | "uses" | "related_to",
): Promise<void> {
  const result = client.unsetConceptRelation(fromConcept, toConcept, { relationType });
  if (result.removed === 0) {
    console.log("No matching relations were removed.");
    return;
  }
  console.log(`Removed ${result.removed} relation${result.removed === 1 ? "" : "s"}.`);
}

export async function relationsListCommand(
  client: WorkerClient,
  opts?: {
    concept?: string;
    includeInactive?: boolean;
  },
): Promise<void> {
  const relations = client.listConceptRelations(opts);
  console.log(formatConceptRelationsCli(relations));
}
