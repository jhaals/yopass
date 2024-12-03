# CDK configuration for deploying yopass in AWS.

This is __primarily__ for the project itself and needs alterations to be used in your own setup.

```
npx cdk deploy
```

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
