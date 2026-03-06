let jsonOutput = false;

export function setJsonOutput(enabled: boolean): void {
  jsonOutput = enabled;
}

export function isJsonOutput(): boolean {
  return jsonOutput;
}

export function emit<T>(value: T, render?: (value: T) => string): T {
  if (jsonOutput) {
    console.log(JSON.stringify(value, null, 2));
    return value;
  }
  if (render) {
    console.log(render(value));
    return value;
  }
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return value;
}
