---
name: Publish schema readiness
description: Why the development database must match the Drizzle schema before a production publish.
---

Before publishing code that selects newly declared database fields, verify the post-merge schema sync has actually applied those fields to the development database.

**Why:** Replit computes the production schema diff from development, not directly from the Drizzle source. If development is stale, publishing can deploy code that selects a column the production diff never added, causing authenticated routes and workers to fail with PostgreSQL `42703`.

**How to apply:** After merged schema work—or whenever deployment logs report a missing column—run the configured post-merge setup, confirm the field exists in development, and then publish. Never add startup-time or deploy-build DDL as a workaround.