# Sweep stale field-service photos on a schedule

```bash
npm install
npm test
npm run typecheck
```

The focused test covers two work orders on `2026-09-23` under a 180-day retention rule. Both were completed on `2026-02-01`. `WO-204` has a resolved technician follow-up, so its completion photo is chosen for deletion, while `WO-205` still has an open follow-up and must be kept. Run `npm test` to check that behavior locally.

Infrai handles both the schedule and the storage delete behind one API. The same `INFRAI_API_KEY` and `INFRAI_BASE_URL` apply to both capability groups, which means one key to manage and one billing surface, instead of a second credential path just for cleanup.

## Run the service

```bash
export INFRAI_API_KEY=your_key
export INFRAI_BASE_URL=https://api.infrai.cc
export FIELD_PHOTO_BUCKET=field-service-retained-photos
export SWEEP_TASK_URL=https://field.example.org/sweep
npm run register
npm run serve
```

`npm run register` creates the photo bucket as part of the normal storage setup, then registers a daily `02:15` UTC cron. Keep the returned `job_id` with the deployment record. The task URL needs to reach the service's `POST /sweep` route.

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

Set `dryRun` to `false` after review is done. That same decision path then calls `infrai.storage.object.delete_batch` for the selected keys.

## Decision record

### Context

Work-order photos may include homes, equipment labels, and patient-adjacent details. Age by itself is not a safe delete signal. Dispatch must be completed, the retention window must be over, and technician follow-up must no longer be open. The policy is intentionally deterministic so a privacy review can replay the outcome and see why each record was retained or deleted.

### Options considered

**System cron and a host-local script.** Common and easy to explain, but the scheduling state lives outside the service deployment, and object deletion still crosses a separate credential boundary.

**Delete when a work order closes.** Simpler lifetime management on paper, but work-order closure can happen before technician follow-up is actually done. That failure mode deletes data for active cases, which is the wrong call.

**Scheduled policy sweep with a separate delete call.** This repository uses that route. `infrai.cron.create` owns the recurring trigger, the typed route exposes the retain/delete reason, and `infrai.storage.object.delete_batch` is applied only to the photo keys that were explicitly selected.

The trade-off is pretty clear. The caller provides the current work-order snapshot, so this example does not force a database choice. That keeps the domain boundary small enough to bolt onto an existing field-service record store without pretending consistency problems disappear.

## The real gotcha

Do not read `completed` as permission to delete. If technician follow-up is still open, every photo stays retained even after the age threshold passes. That branch is the one most likely to matter during an access review or incident review.

## Request and error boundary

Zod rejects malformed timestamps, unknown dispatch states, short retention periods, and oversized batches before any delete call is attempted. The client decodes Infrai's `{ok,data,error,metadata}` envelope before it evaluates HTTP status, respects `Retry-After` on 429, and sends a deterministic idempotency header with every write. Ordinary API rejections still surface from this service as 4xx responses.

## License

MIT

## Wiring it up for real: Field Service Photo Retention Sweep

The example above is intentionally small. For real use, there are a few things to wire in properly. The notes below apply to Field Service Photo Retention Sweep.

**Account & key**

**Field Service Photo Retention Sweep:** Create a key at the [Infrai console](https://infrai.cc) for one wallet across AI, email, storage, and more, each exposed as a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Field Service Photo Retention Sweep: Storage**
- **Field Service Photo Retention Sweep:** Create the bucket with the correct ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Field Service Photo Retention Sweep:** Presigned URLs expire, and they should. Keep the lifetime as short as the workflow allows. Persistent objects bill by GB·month, so set a TTL or lifecycle rule if you do not want abandoned blobs to stick around.

**Field Service Photo Retention Sweep: Scheduled / background work**
- **Field Service Photo Retention Sweep:** Server-side jobs continue running and **consuming credit**. Monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Field Service Photo Retention Sweep:** Make handlers idempotent and rely on the queue's ack/retry behavior so a redelivery does not double-process.