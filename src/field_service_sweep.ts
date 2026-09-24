import { createServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { infrai, InfraiError } from "./infrai_client.js";
import { decidePhotoRetention, sweepRequestSchema, type SweepRequest } from "./retention_policy.js";

const bucket = process.env.FIELD_PHOTO_BUCKET ?? "field-service-retained-photos";

export async function runSweep(raw: unknown) {
  const input = sweepRequestSchema.parse(raw);
  const decisions = input.workOrders.map((order) =>
    decidePhotoRetention(order, new Date(input.evaluatedAt), input.retentionDays),
  );
  const photoKeys = [...new Set(decisions.flatMap((decision) => decision.photoKeys))].sort();

  if (!input.dryRun && photoKeys.length > 0) {
    await infrai.storage.object.delete_batch(bucket, { keys: photoKeys });
  }
  return {
    evaluated: decisions.length,
    selectedPhotos: photoKeys,
    deletionApplied: !input.dryRun && photoKeys.length > 0,
    decisions,
  };
}

export async function registerSweep(): Promise<{ job_id: string; bucket: string }> {
  const task = new URL(process.env.SWEEP_TASK_URL ?? "");
  await infrai.storage.bucket.create({ name: bucket });
  const result = await infrai.cron.create({ cron_expr: "15 2 * * *", task: task.toString() });
  return { job_id: result.job_id, bucket };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 256_000) throw new RangeError("Request body exceeds 256 KB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function serve(): void {
  const port = Number(process.env.PORT ?? "3000");
  createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/sweep") {
      json(response, 404, { error: "route_not_found" });
      return;
    }
    try {
      json(response, 200, await runSweep(await readBody(request)));
    } catch (error) {
      if (error instanceof ZodError || error instanceof SyntaxError || error instanceof RangeError) {
        json(response, 400, { error: "invalid_sweep_request" });
        return;
      }
      if (error instanceof InfraiError && error.status >= 400 && error.status < 500) {
        json(response, error.status, { error: error.code });
        return;
      }
      json(response, 502, { error: "cleanup_dependency_error" });
    }
  }).listen(port, () => console.log(`Field-service sweep listening on ${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === "serve") serve();
  else if (command === "register") {
    registerSweep().then((result) => console.log(JSON.stringify(result))).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  } else {
    console.error("Use: npm run serve | npm run register");
    process.exitCode = 1;
  }
}

export type { SweepRequest };
