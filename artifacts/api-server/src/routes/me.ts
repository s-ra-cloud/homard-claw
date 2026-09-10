import { GetMeResponse } from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import { isOwnerRequest } from "../workspace";

const router: IRouter = Router();

router.get("/me", async (req, res): Promise<void> => {
  res.json(GetMeResponse.parse({ isOwner: await isOwnerRequest(req) }));
});

export default router;
