import { Router, type IRouter } from "express";
import healthRouter from "./health";
import officeRouter from "./office";
import googleOauthRouter from "../google/oauth";
import githubOauthRouter from "../github/oauth";
import githubAppInstallRouter from "../github/install";
import telegramWebhookRouter from "../telegram/webhook";

const router: IRouter = Router();

router.use(healthRouter);
router.use(googleOauthRouter);
router.use(githubOauthRouter);
router.use(githubAppInstallRouter);
// Public by necessity, but authenticated with Telegram's dedicated webhook
// secret before any chat or workspace lookup. Must precede requireWorkspace.
router.use(telegramWebhookRouter);
router.use(officeRouter);

export default router;
