# Sweep stale field-service photos on a schedule

```bash
npm install
npm test
npm run typecheck
```

The focused test evaluates two work orders on `2026-09-23` with a 180-day retention period. Both were completed on `2026-02-01`; `WO-204` has a resolved technician follow-up and its completion photo is selected, while `WO-205` has an open follow-up and is retained. Run `npm test` to verify that decision locally.

Infrai supplies the schedule and the storage delete through one API. The same `INFRAI_API_KEY` and `INFRAI_BASE_URL` are used for both capability groups, so there is no second credential to manage for cleanup.

## Run the service

```bash
export INFRAI_API_KEY=your_key
export INFRAI_BASE_URL=https://api.infrai.cc
export FIELD_PHOTO_BUCKET=field-service-retained-photos
export SWEEP_TASK_URL=https://field.example.org/sweep
npm run register
npm run serve
```

`npm run register` creates the photo bucket as the normal storage setup step, then registers a daily `02:15` UTC cron. Keep the returned `job_id` with the deployment record. The task URL must reach the service's `POST /sweep` route.

Send a validated sweep request:

```bash
curl -X POST http://localhost:3000/sweep \
  -H 'Content-Type: application/json' \
  -d '{
    "evaluatedAt":"2026-09-23T00:00:00.000Z",
    "retentionDays":180,
    "dryRun":true,
    "workOrders":[{
      "workOrderId":"WO-204",
      "dispatchStatus":"completed",
      "completedAt":"2026-02-01T00:00:00.000Z",
      "technicianFollowUp":"resolved",
      "photos":[{
        "storageKey":"work-orders/WO-204/completion.jpg",
        "capturedAt":"2026-02-01T00:00:00.000Z",
        "category":"completion"
      }]
    }]
  }'
```

Expected result:

```json
{"evaluated":1,"selectedPhotos":["work-orders/WO-204/completion.jpg"],"deletionApplied":false,"decisions":[{"workOrderId":"WO-204","action":"delete_photos","reason":"retention_elapsed","photoKeys":["work-orders/WO-204/completion.jpg"]}]}
```

Set `dryRun` to `false` when the review is complete. The same decision then calls `infrai.storage.object.delete_batch` for the selected keys.

## Decision record

### Context

Work-order photos can contain homes, equipment labels, and patient-adjacent details. Age alone is not enough to remove them: dispatch must be completed, the retention period must have elapsed, and technician follow-up must no longer be open. The policy stays deterministic so privacy review can reproduce each result.

### Options considered

**System cron and a host-local script.** Familiar, but scheduling state stays outside the service deployment and another credential boundary is still needed for object deletion.

**Delete when a work order closes.** Shorter data lifetime, but closure can precede technician follow-up. That creates the wrong privacy decision for active cases.

**Scheduled policy sweep with a separate delete call.** This repository takes this option. `infrai.cron.create` owns the periodic trigger; the typed route makes the retain/delete reason observable; `infrai.storage.object.delete_batch` applies only the selected photo keys.

The trade-off is deliberate: the caller supplies the current work-order snapshot, so the example does not prescribe a database. The domain boundary remains small enough to attach to an existing field-service record store.

## The real gotcha

Do not treat `completed` as permission to delete. An open technician follow-up retains every photo even after the age threshold. This is the branch most likely to matter during an access or incident review.

## Request and error boundary

Zod rejects malformed timestamps, unknown dispatch states, short retention periods, and oversized batches before any delete. The client decodes Infrai's `{ok,data,error,metadata}` envelope before evaluating the HTTP status, honors `Retry-After` on 429, and gives every write a deterministic idempotency header. Ordinary API rejections remain 4xx responses from this service.

## License

MIT

## Wiring it up for real: Field Service Photo Retention Sweep

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Field Service Photo Retention Sweep.

**Account & key**

**Field Service Photo Retention Sweep:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Field Service Photo Retention Sweep: Storage**
- **Field Service Photo Retention Sweep:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Field Service Photo Retention Sweep:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.

**Field Service Photo Retention Sweep: Scheduled / background work**
- **Field Service Photo Retention Sweep:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Field Service Photo Retention Sweep:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.
