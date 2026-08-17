#!/usr/bin/env node
/**
 * The `gifi` command.
 *
 * Deliberately narrow: inspect and clean, plus usage and jobs for checking
 * what a run cost. Rewriting is on the API and in the SDK, but it is not here
 * — spending credits in a shell one-liner is easy to do by accident, and
 * inspect is what you want first anyway.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { GifiClient, GifiError } from "./index.js";

export type Command = "inspect" | "clean" | "usage" | "jobs";

export interface ParsedArgs {
  command: Command;
  text?: string;
  file?: string;
  out?: string;
  limit?: number;
  baseUrl: string;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

const USAGE = `gifi — inspect and clean AI provenance marks

  gifi inspect --text "..."            what is hidden in this text
  gifi inspect --file photo.jpg        what metadata this file carries
  gifi clean   --text "..."            remove invisible characters (free)
  gifi clean   --file p.jpg --out c.jpg  strip metadata (1 credit)
  gifi usage                           credits, plan and recent usage
  gifi jobs [--limit 20]               recent jobs, newest first

Set GIFI_API_KEY to a key from https://gifi.ai/api-keys.
Set GIFI_BASE_URL to point at another deployment.`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "inspect" && command !== "clean" && command !== "usage" && command !== "jobs") {
    throw new CliError(USAGE);
  }

  const parsed: ParsedArgs = {
    command,
    baseUrl: (env.GIFI_BASE_URL ?? "https://gifi.ai").replace(/\/$/, ""),
  };

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--text" && value) {
      parsed.text = value;
      i += 1;
    } else if (flag === "--file" && value) {
      parsed.file = value;
      i += 1;
    } else if (flag === "--out" && value) {
      parsed.out = value;
      i += 1;
    } else if (flag === "--limit" && value) {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1) throw new CliError("--limit must be a positive integer");
      parsed.limit = limit;
      i += 1;
    } else {
      throw new CliError(`Unknown argument: ${flag}`);
    }
  }

  if (command === "inspect" || command === "clean") {
    if (!parsed.text && !parsed.file) throw new CliError("Provide --text or --file");
    if (parsed.text && parsed.file) throw new CliError("Provide --text or --file, not both");
  }

  return parsed;
}

export async function run(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const apiKey = env.GIFI_API_KEY?.trim();
  if (!apiKey) throw new CliError("Set GIFI_API_KEY to a key from https://gifi.ai/api-keys");

  const client = new GifiClient({ apiKey, baseUrl: args.baseUrl, fetch: fetchImpl });

  if (args.command === "usage") {
    return JSON.stringify((await client.usage()).data, null, 2);
  }

  if (args.command === "jobs") {
    const page = await client.listJobs({ limit: args.limit ?? 20 });
    return JSON.stringify(page.data, null, 2);
  }

  const input = args.text
    ? { text: args.text }
    : { file: await readFile(args.file!), filename: basename(args.file!) };

  const response =
    args.command === "inspect" ? await client.inspect(input) : await client.clean(input);

  const body = response.data as { file?: string };
  if (args.command === "clean" && args.out && typeof body.file === "string") {
    await writeFile(args.out, Buffer.from(body.file, "base64"));
    return `Wrote ${args.out}`;
  }

  return JSON.stringify(response.data, null, 2);
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${await run(parseArgs(process.argv.slice(2)))}\n`);
  } catch (err) {
    if (err instanceof GifiError) {
      // The hint is the whole point of the error model; printing only the
      // message would throw away the half that says what to do next.
      process.stderr.write(`${err.message}\n${err.hint}\n`);
      process.exit(err.retryable ? 75 : 1);
    }
    process.stderr.write(`${err instanceof Error ? err.message : "Failed"}\n`);
    process.exit(err instanceof CliError ? err.exitCode : 1);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
