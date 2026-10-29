import serverless from "serverless-http";

import app from "../../src/app";

export const handler = serverless(app, {
  binary: [
    "application/pdf",
    "image/*",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/octet-stream",
  ],
});