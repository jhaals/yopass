import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as dynamo from "aws-cdk-lib/aws-dynamodb";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

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

    const serverLambda = new lambda.Function(this, "Yopass", {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: "bootstrap",
      code: lambda.Code.fromAsset("deployment.zip"),
      memorySize: 128,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        TABLE_NAME: "yopass",
        MAX_LENGTH: "10000",
      },
    });

    table.grantReadWriteData(serverLambda);

    const gateway = new apigw.LambdaRestApi(this, "Gateway", {
      handler: serverLambda,
      restApiName: "yopass",
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
