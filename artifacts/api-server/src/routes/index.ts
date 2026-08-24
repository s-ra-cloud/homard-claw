import { Router, type IRouter } from "express";
import healthRouter from "./health";
import officeRouter from "./office";
import googleOauthRouter from "../google/oauth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(googleOauthRouter);
router.use(officeRouter);

export default router;
