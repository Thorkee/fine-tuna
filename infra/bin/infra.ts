#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { TunaInfraStack } from "../lib/infra-stack";

const app = new cdk.App();
new TunaInfraStack(app, "TunaInfraStack", {
  env: { account: "272861537879", region: "us-east-1" },
});
