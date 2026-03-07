#!/usr/bin/env bun
import { runLoreCli } from "./cli.ts";

await runLoreCli(process.argv.slice(2));
