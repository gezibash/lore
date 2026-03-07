import { Argument, Command, Option } from "commander";
import type { CliArgSpec, CliCommandSpec, CliOptionSpec, CliSpec } from "./cli-schema.ts";
import { isJsonOutput } from "./output.ts";

function parseNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid value for '${name}': expected a number.`);
  }
  return parsed;
}

function castOptionValue(value: string, name: string, spec: CliOptionSpec): unknown {
  if (spec.type === "number") {
    return parseNumber(value, name);
  }
  return value;
}

function buildArgumentToken(name: string, spec: CliArgSpec): string {
  return spec.required ? `<${name}>` : `[${name}]`;
}

function createArgument(name: string, spec: CliArgSpec): Argument {
  const argument = new Argument(buildArgumentToken(name, spec), spec.description);
  if (spec.type === "number") {
    argument.argParser((value) => parseNumber(value, name));
  }
  if (spec.default !== undefined) {
    argument.default(spec.default);
  }
  return argument;
}

function buildOptionFlags(name: string, spec: CliOptionSpec): string {
  const long =
    spec.type === "boolean" ? `--${name}` : `--${name} <${spec.type === "number" ? "number" : "string"}>`;
  return spec.short ? `-${spec.short}, ${long}` : long;
}

function createOption(name: string, spec: CliOptionSpec): Option {
  const option = new Option(buildOptionFlags(name, spec), spec.description);
  if (spec.repeatable) {
    option.argParser((value, previous) => {
      const values = Array.isArray(previous) ? previous : [];
      return [...values, castOptionValue(value, name, spec)];
    });
    return option;
  }
  if (spec.type === "number") {
    option.argParser((value) => parseNumber(value, name));
  }
  return option;
}

function applySharedFlags(command: Command, version: string): void {
  command.exitOverride();
  command.configureOutput({
    // Let runLoreCli own parse-error rendering so text and JSON modes stay consistent.
    writeErr: () => {},
  });
  command.helpOption("-h, --help", "Show help");
  command.version(version, "-V, --version", "Show version");
}

function applyOptions(command: Command, options: Record<string, CliOptionSpec> | undefined): void {
  if (!options) return;
  for (const [name, spec] of Object.entries(options)) {
    command.addOption(createOption(name, spec));
  }
}

function buildAction(
  commandSpec: CliCommandSpec,
  globalOptions: Record<string, CliOptionSpec>,
) {
  const argEntries = Object.entries(commandSpec.arguments ?? {});
  const optionEntries = [
    ...Object.entries(globalOptions),
    ...Object.entries(commandSpec.options ?? {}),
  ];
  return async (...values: unknown[]) => {
    const command = values.at(-1) as Command;
    const positional = values.slice(0, argEntries.length);
    const args = Object.fromEntries(argEntries.map(([name], index) => [name, positional[index]]));
    const parsedOptions = command.opts();
    const options = Object.fromEntries(
      optionEntries.map(([name, spec]) => {
        const attributeName = createOption(name, spec).attributeName();
        return [name, parsedOptions[attributeName]];
      }),
    );
    await commandSpec.action?.({ args, options });
  };
}

function buildCommand(
  commandSpec: CliCommandSpec,
  version: string,
  globalOptions: Record<string, CliOptionSpec>,
): Command {
  const command = new Command(commandSpec.name);
  if (commandSpec.description) {
    command.description(commandSpec.description);
  }

  applySharedFlags(command, version);
  applyOptions(command, globalOptions);
  applyOptions(command, commandSpec.options);

  for (const [name, spec] of Object.entries(commandSpec.arguments ?? {})) {
    command.addArgument(createArgument(name, spec));
  }

  for (const childSpec of Object.values(commandSpec.subcommands ?? {})) {
    command.addCommand(buildCommand(childSpec, version, globalOptions));
  }

  if (commandSpec.action) {
    command.action(buildAction(commandSpec, globalOptions));
  }

  return command;
}

export function buildCommanderCli(spec: CliSpec): Command {
  const program = new Command(spec.name);
  if (spec.description) {
    program.description(spec.description);
  }
  program.usage("<command> [options]");

  applySharedFlags(program, spec.version);
  applyOptions(program, spec.globalOptions);

  for (const childSpec of Object.values(spec.commands)) {
    program.addCommand(buildCommand(childSpec, spec.version, spec.globalOptions ?? {}));
  }

  return program;
}
