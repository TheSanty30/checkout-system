import dotenv from "dotenv";
dotenv.config();

export const env = {
  PORT: Number(process.env.PORT || 3000),
  DOMAIN: (process.env.DOMAIN || "http://localhost:3000").replace(/\/+$/, ""),
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
  MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY,
  MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET,
};
