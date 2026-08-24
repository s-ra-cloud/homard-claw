import {
  ListNotificationsQueryParams,
  ListNotificationsResponse,
  MarkNotificationsReadBody,
  MarkNotificationsReadResponse,
} from "@workspace/api-zod";
import { db, notificationsTable } from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { publish } from "../events";

const router: IRouter = Router();

router.get("/notifications", async (req, res): Promise<void> => {
  const query = ListNotificationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid notification query" });
    return;
  }
  const limit = query.data.limit ?? 50;
  const wsScope = eq(notificationsTable.workspaceId, req.workspaceId!);
  const [rows, [unread]] = await Promise.all([
    db
      .select()
      .from(notificationsTable)
      .where(
        query.data.unreadOnly
          ? and(wsScope, isNull(notificationsTable.readAt))
          : wsScope,
      )
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationsTable)
      .where(and(wsScope, isNull(notificationsTable.readAt))),
  ]);
  res.json(
    ListNotificationsResponse.parse({
      unread: unread?.count ?? 0,
      notifications: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        taskId: row.taskId,
        agentId: row.agentId,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
      })),
    }),
  );
});

router.post("/notifications/read", async (req, res): Promise<void> => {
  const parsed = MarkNotificationsReadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const wsScope = eq(notificationsTable.workspaceId, req.workspaceId!);
  const scope = parsed.data.ids?.length
    ? and(wsScope, isNull(notificationsTable.readAt), inArray(notificationsTable.id, parsed.data.ids))
    : and(wsScope, isNull(notificationsTable.readAt));
  const updated = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(scope)
    .returning({ id: notificationsTable.id });
  if (updated.length > 0) publish(req.workspaceId!, "notifications");
  res.json(MarkNotificationsReadResponse.parse({ updated: updated.length }));
});

export default router;
