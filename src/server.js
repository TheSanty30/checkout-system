import express from "express";
import cors from "cors";
import morgan from "morgan";
import paymentRoutes from "./routes/payment.routes.js";
import { env } from "./config/env.js";

const app = express();

app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(paymentRoutes);

app.listen(env.PORT, () => {
  console.log("Server on port", env.PORT);
  console.log("Domain:", env.DOMAIN);
});
