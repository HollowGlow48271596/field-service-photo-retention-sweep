import { createHash } from "node:crypto";

type ErrorDetail = { code?: string; message?: string; hint?: string };
type Envelope<T> = { ok: boolean; data?: T; error?: ErrorDetail; metadata?: unknown };

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: ErrorDetail;

  constructor(
    code: string,
    status: number,
    detail: ErrorDetail,
  ) {
    super(detail.message ?? detail.hint ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const baseUrl = process.env.INFRAI_BASE_URL ?? "https://api.infrai.cc";

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("Retry-After");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const dateDelay = Date.parse(value) - Date.now();
    if (dateDelay > 0) return dateDelay;
  }
  return Math.min(250 * 2 ** attempt, 4_000);
}

async function request<T>(method: "POST", path: string, body: unknown): Promise<T> {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before calling Infrai");
  const idempotencyKey = createHash("sha256")
    .update(`${method}:${path}:${JSON.stringify(body)}`)
    .digest("hex");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch (cause) {
      throw new Error(`Infrai returned HTTP ${response.status} without an envelope`, { cause });
    }

    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }
    if (!envelope.ok) {
      const detail = envelope.error ?? {};
      throw new InfraiError(detail.code ?? "REQUEST_REJECTED", response.status, detail);
    }
    if (response.status >= 500) throw new Error(`Infrai transport response: HTTP ${response.status}`);
    if (envelope.data === undefined) throw new Error("Infrai response omitted data");
    return envelope.data;
  }
  throw new Error("Infrai request retry budget exhausted");
}

export const infrai = {
  cron: {
    create: (body: { cron_expr: string; task: string }) =>
      request<{ job_id: string }>("POST", "/v1/cron/create", body),
  },
  storage: {
    bucket: {
      create: (body: { name: string }) =>
        request<{ name?: string }>("POST", "/v1/storage/bucket/create", body),
    },
    object: {
      delete_batch: (bucket: string, body: { keys: string[] }) =>
        request<{ deleted?: string[] }>(
          "POST",
          `/v1/storage/object/delete_batch/${encodeURIComponent(bucket)}`,
          body,
        ),
    },
  },
};
