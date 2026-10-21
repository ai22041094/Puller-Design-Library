import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pullerLibraryRouter from "./puller-library";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pullerLibraryRouter);

export default router;
