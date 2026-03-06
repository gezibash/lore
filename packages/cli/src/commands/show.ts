import { formatShow, type WorkerClient } from "@lore/worker";
import { emit } from "../output.ts";

export function parseShowTarget(target: string): { concept: string; ref?: string } {
  const splitAt = target.lastIndexOf("@");
  if (splitAt <= 0 || splitAt === target.length - 1) {
    return { concept: target };
  }
  return {
    concept: target.slice(0, splitAt),
    ref: target.slice(splitAt + 1),
  };
}

export async function showCommand(
  client: WorkerClient,
  target: string,
  fromResultId?: string,
): Promise<void> {
  const { concept, ref } = parseShowTarget(target);
  const result = await client.show(concept, {
    ...(ref ? { ref } : {}),
    ...(fromResultId ? { fromResultId } : {}),
  });
  emit(result, (value) => formatShow(concept, value));
}
