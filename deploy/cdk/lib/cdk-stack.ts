import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as dynamo from "aws-cdk-lib/aws-dynamodb";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import * as path from "path";
import { spawnSync } from "child_process";

const domainName = "api.yopass.se";

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamo.Table(this, "YopassTable", {
      tableName: "yopass",
      partitionKey: { name: "id", type: dynamo.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      writeCapacity: 10,
      readCapacity: 10,
    });

    const cert = new acm.Certificate(this, "Certificate", {
      domainName,
      validation: acm.CertificateValidation.fromDns(),
    });

    const repoRoot = path.join(__dirname, "../../..");

    const serverLambda = new lambda.Function(this, "Yopass", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(repoRoot, {
        bundling: {
          image: cdk.DockerImage.fromRegistry("golang:1.25"),
          environment: {
            GOCACHE: "/tmp/go-build",
            GOPATH: "/tmp/go",
          },
          command: [
            "sh",
            "-c",
            "cd /asset-input/deploy/cdk && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -o /asset-output/bootstrap .",
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              const result = spawnSync(
                "go",
                [
                  "build",
                  "-tags",
                  "lambda.norpc",
                  "-o",
                  path.join(outputDir, "bootstrap"),
                  ".",
                ],
                {
                  cwd: path.join(__dirname, ".."),
                  env: {
                    ...process.env,
                    GOOS: "linux",
                    GOARCH: "arm64",
                    CGO_ENABLED: "0",
                  },
                  stdio: "inherit",
                }
              );
              return result.status === 0;
            },
          },
        },
      }),
      memorySize: 128,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        TABLE_NAME: "yopass",
        MAX_LENGTH: "10000",
        MAX_FILE_SIZE: "128KB",
      },
    });

    table.grantReadWriteData(serverLambda);

    const gateway = new apigw.LambdaRestApi(this, "Gateway", {
      handler: serverLambda,
      restApiName: "yopass",
      binaryMediaTypes: ["application/octet-stream"],
    });
    gateway.addUsagePlan("yopass-usage-plan", {
      quota: { limit: 1000, period: apigw.Period.DAY },
      throttle: { rateLimit: 50, burstLimit: 25 },
    });

    const domain = gateway.addDomainName("Domain Name", {
      domainName,
      certificate: cert,
    });

    new cdk.CfnOutput(this, "API Gateway Domain Name", {
      value: domain.domainNameAliasDomainName,
    });
  }
}
