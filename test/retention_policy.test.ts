import assert from "node:assert/strict";
import test from "node:test";
import { decidePhotoRetention, workOrderSchema } from "../src/retention_policy.js";

const evaluatedAt = new Date("2026-09-23T00:00:00.000Z");

test("deletes only old completed work-order photos after follow-up is resolved", () => {
  const base = {
    dispatchStatus: "completed" as const,
    completedAt: "2026-02-01T00:00:00.000Z",
    photos: [{
      storageKey: "work-orders/WO-204/completion.jpg",
      capturedAt: "2026-02-01T00:00:00.000Z",
      category: "completion" as const,
    }],
  };
  const resolved = workOrderSchema.parse({ ...base, workOrderId: "WO-204", technicianFollowUp: "resolved" });
  const pending = workOrderSchema.parse({ ...base, workOrderId: "WO-205", technicianFollowUp: "open" });

  assert.deepEqual(decidePhotoRetention(resolved, evaluatedAt, 180), {
    workOrderId: "WO-204",
    action: "delete_photos",
    reason: "retention_elapsed",
    photoKeys: ["work-orders/WO-204/completion.jpg"],
  });
  assert.equal(decidePhotoRetention(pending, evaluatedAt, 180).reason, "follow_up_open");
});
