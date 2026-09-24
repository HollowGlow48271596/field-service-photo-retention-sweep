import { z } from "zod";

export const workOrderSchema = z.object({
  workOrderId: z.string().min(1),
  dispatchStatus: z.enum(["scheduled", "dispatched", "on_site", "completed", "cancelled"]),
  completedAt: z.string().datetime().nullable(),
  technicianFollowUp: z.enum(["open", "resolved", "not_required"]),
  photos: z.array(z.object({
    storageKey: z.string().min(1),
    capturedAt: z.string().datetime(),
    category: z.enum(["arrival", "repair", "completion"]),
  })).max(20),
});

export const sweepRequestSchema = z.object({
  evaluatedAt: z.string().datetime(),
  retentionDays: z.number().int().min(30).max(3650).default(180),
  dryRun: z.boolean().default(true),
  workOrders: z.array(workOrderSchema).max(500),
});

export type SweepRequest = z.infer<typeof sweepRequestSchema>;
export type WorkOrder = z.infer<typeof workOrderSchema>;

export type RetentionDecision = {
  workOrderId: string;
  action: "delete_photos" | "retain";
  reason: "retention_elapsed" | "dispatch_active" | "follow_up_open" | "retention_active";
  photoKeys: string[];
};

export function decidePhotoRetention(
  order: WorkOrder,
  evaluatedAt: Date,
  retentionDays: number,
): RetentionDecision {
  if (order.dispatchStatus !== "completed" || !order.completedAt) {
    return { workOrderId: order.workOrderId, action: "retain", reason: "dispatch_active", photoKeys: [] };
  }
  if (order.technicianFollowUp === "open") {
    return { workOrderId: order.workOrderId, action: "retain", reason: "follow_up_open", photoKeys: [] };
  }

  const cutoff = evaluatedAt.getTime() - retentionDays * 86_400_000;
  if (Date.parse(order.completedAt) >= cutoff) {
    return { workOrderId: order.workOrderId, action: "retain", reason: "retention_active", photoKeys: [] };
  }
  return {
    workOrderId: order.workOrderId,
    action: "delete_photos",
    reason: "retention_elapsed",
    photoKeys: order.photos.map((photo) => photo.storageKey),
  };
}
