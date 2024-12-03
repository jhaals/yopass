import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as Cdk from "../lib/cdk-stack";

// example test. To run these tests, uncomment this file along with the
// example resource in lib/cdk-stack.ts
test("SQS Queue Created", () => {
  const app = new cdk.App();

  const stack = new Cdk.CdkStack(app, "Yopass");

  const template = Template.fromStack(stack);
  // console.log(template.toJSON());
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "yopass",
  });
});
