# CDK configuration for deploying yopass in AWS.

This is __primarily__ for the project itself and needs alterations to be used in your own setup.

## One-time setup

The stack resolves the yopass license key from SSM Parameter Store at deploy time:

```
aws ssm put-parameter --name /yopass/license-key --type String --value '<jwt>'
```

## Deploy

```
npx cdk deploy
```

CORS is restricted to the official frontends (`share.yopass.se`, `demo.yopass.se`)
and Netlify deploy previews (`deploy-preview-*--yopass.netlify.app`). Origins are
configured via the `CORS_ALLOWED_ORIGINS` Lambda environment variable in
`lib/cdk-stack.ts`; requests from other origins receive no
`Access-Control-Allow-Origin` header.

```
GOOS=linux GOARCH=arm64 go build -o ./bootstrap -tags lambda.norpc
zip deployment.zip bootstrap
```


The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
