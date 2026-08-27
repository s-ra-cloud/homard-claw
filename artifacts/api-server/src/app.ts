import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    // Webhook authentication failures are counted in-memory and otherwise
    // silent. Suppress pino-http's automatic request/completion lines too,
    // so neither an invalid secret attempt nor its source is logged.
    autoLogging: {
      ignore: (req) => req.url?.split("?")[0] === "/api/telegram/webhook",
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// The web app and this API share one origin (path routing), so browsers
// never need cross-origin credentials. Reflecting arbitrary origins with
// credentials enabled would let any website ride the owner's session, so
// only this deployment's own hosts (and local dev) are allowed.
const allowedCorsHosts = new Set<string>(
  [
    ...(process.env.REPLIT_DOMAINS ?? "").split(","),
    process.env.REPLIT_DEV_DOMAIN ?? "",
  ]
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // No Origin header = same-origin navigation or a non-browser client.
      if (!origin) return callback(null, true);
      try {
        const { hostname } = new URL(origin);
        const host = hostname.toLowerCase();
        callback(
          null,
          host === "localhost" ||
            host === "127.0.0.1" ||
            allowedCorsHosts.has(host),
        );
      } catch {
        callback(null, false);
      }
    },
  }),
);
// Voice recordings arrive as base64 JSON; allow a few minutes of audio.
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

// Final safety net: no stack trace or internal detail ever reaches a
// client. The full error still goes to the server log.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    (
      req as unknown as { log?: { error: (o: unknown, m: string) => void } }
    ).log?.error({ err }, "Unhandled route error");
    res.status(500).json({ error: "Internal server error" });
  },
);

export default app;
