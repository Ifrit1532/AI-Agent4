import { Router, type IRouter } from "express";
import healthRouter from "./health";
import matchRouter from "./match";

const router: IRouter = Router();

router.use(healthRouter);
router.use(matchRouter);

export default router;
