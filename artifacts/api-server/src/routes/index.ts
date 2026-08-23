import { Router, type IRouter } from "express";
import healthRouter from "./health";
import officeRouter from "./office";

const router: IRouter = Router();

router.use(healthRouter);
router.use(officeRouter);

export default router;
