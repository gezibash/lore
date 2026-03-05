import type { WorkerClient, ResolveDangling, DanglingAction, NarrativeTarget } from "@lore/worker";
import { formatOpen } from "@lore/worker";

/**
 * Parse a --target spec string into a NarrativeTarget.
 * Syntax:
 *   create:<concept>
 *   update:<concept>
 *   archive:<concept>[:<reason>]
 *   restore:<concept>
 *   rename:<from>:<to>
 *   merge:<source>:<into>[:<reason>]
 *   split:<concept>[:<parts>]
 */
export function parseTargetSpec(spec: string): NarrativeTarget {
  const parts = spec.split(":");
  const op = parts[0];

  switch (op) {
    case "create":
    case "update":
    case "restore": {
      const concept = parts.slice(1).join(":");
      if (!concept) throw new Error(`--target ${op}: missing concept name`);
      return { op, concept } as NarrativeTarget;
    }
    case "archive": {
      const [concept, ...rest] = parts.slice(1);
      if (!concept) throw new Error(`--target archive: missing concept name`);
      return { op: "archive", concept, reason: rest.length > 0 ? rest.join(":") : undefined };
    }
    case "rename": {
      const [from, ...toParts] = parts.slice(1);
      const to = toParts.join(":");
      if (!from || !to) throw new Error(`--target rename: requires <from>:<to>`);
      return { op: "rename", from, to };
    }
    case "merge": {
      const [source, into, ...rest] = parts.slice(1);
      if (!source || !into) throw new Error(`--target merge: requires <source>:<into>`);
      return { op: "merge", source, into, reason: rest.length > 0 ? rest.join(":") : undefined };
    }
    case "split": {
      const [concept, partsStr] = parts.slice(1);
      if (!concept) throw new Error(`--target split: missing concept name`);
      const partsNum = partsStr ? parseInt(partsStr, 10) : undefined;
      return { op: "split", concept, parts: partsNum };
    }
    default:
      throw new Error(
        `Unknown --target op '${op}'. Use: create, update, archive, restore, rename, merge, split`,
      );
  }
}

export async function openCommand(
  client: WorkerClient,
  delta: string,
  intent: string,
  resolve?: string,
  targetSpecs?: string[],
): Promise<void> {
  let resolveDangling: ResolveDangling | undefined;
  if (resolve) {
    const [name, action] = resolve.split(":");
    if (!name || !action) {
      throw new Error("Invalid --resolve syntax. Use name:resume or name:abandon.");
    }
    if (action !== "resume" && action !== "abandon") {
      throw new Error(
        `Invalid --resolve action '${action}'. Use resume or abandon. Close is a separate command.`,
      );
    }
    resolveDangling = { narrative: name, action: action as DanglingAction };
  }

  const targets: NarrativeTarget[] | undefined =
    targetSpecs && targetSpecs.length > 0 ? targetSpecs.map(parseTargetSpec) : undefined;

  const result = await client.open(delta, intent, { resolveDangling, targets });
  console.log(formatOpen(result));
}
