type CliValueType = "string" | "number" | "boolean";

export type CliArgSpec = {
  type: Exclude<CliValueType, "boolean">;
  required?: boolean;
  description?: string;
  default?: string | number;
};

export type CliOptionSpec = {
  type: CliValueType;
  short?: string;
  description?: string;
  repeatable?: boolean;
};

type CliActionContext = {
  args: Record<string, any>;
  options: Record<string, any>;
};

export type CliCommandSpec = {
  name: string;
  description?: string;
  arguments?: Record<string, CliArgSpec>;
  options?: Record<string, CliOptionSpec>;
  subcommands?: Record<string, CliCommandSpec>;
  action?: (context: CliActionContext) => unknown | Promise<unknown>;
};

export type CliSpec = {
  name: string;
  version: string;
  description?: string;
  globalOptions?: Record<string, CliOptionSpec>;
  commands: Record<string, CliCommandSpec>;
  onError?: (error: unknown) => void;
};

export function defineCommand<T extends CliCommandSpec>(spec: T): T {
  return spec;
}

export function defineCli<T extends CliSpec>(spec: T): T {
  return spec;
}
