import type { WorkerClient } from "@lore/worker";
import { formatConceptTagsCli } from "../formatters.ts";

export async function conceptTagCommand(
  client: WorkerClient,
  concept: string,
  tag: string,
): Promise<void> {
  const result = client.tagConcept(concept, tag);
  console.log(`Tagged ${result.concept} with '${result.tag}'.`);
}

export async function conceptUntagCommand(
  client: WorkerClient,
  concept: string,
  tag: string,
): Promise<void> {
  const result = client.untagConcept(concept, tag);
  if (result.removed === 0) {
    console.log(`Tag '${result.tag}' was not set on ${result.concept}.`);
    return;
  }
  console.log(`Removed tag '${result.tag}' from ${result.concept}.`);
}

export async function conceptTagsListCommand(
  client: WorkerClient,
  concept?: string,
): Promise<void> {
  const tags = client.listConceptTags({ concept });
  console.log(formatConceptTagsCli(tags));
}
