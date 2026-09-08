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
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -mod=mod -o ./bootstrap -tags lambda.norpc
zip deployment.zip bootstrap
```

The Lambda module uses the repository root module through a local `replace`.
Bundling uses `-mod=mod` so root dependency updates can be resolved during the
build. Run `go mod tidy` in this directory to sync `go.mod` and `go.sum`, then
`go test .` to test the Lambda package without traversing Go templates in
`node_modules`.


The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

### DynamoDB security regression tests

Run DynamoDB Local, then run the adapter and HTTP integration tests:

```sh
docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local:3.3.0
# In another terminal, from deploy/cdk:
DYNAMODB_ENDPOINT=http://localhost:8000 go test . -race
```

The tests use dummy credentials and temporary tables. They cover exclusive
one-time claims, expiration before physical TTL cleanup, and concurrent request
updates and revocation. Without `DYNAMODB_ENDPOINT` these integration tests skip;
CI supplies it. Use a dedicated local database for tests.

Deploy all Lambda instances with the updated adapter before relying on these
guarantees: older instances still use unconditional writes and deletion claims.
Existing records without a revision are supported and receive one on their
first conditional update. Records with missing or invalid TTL metadata are
treated as unavailable.

`Dynamo.Update` caps the returned secret's expiration at the record's existing
absolute expiry. Updates can shorten retention but cannot extend it, including
time spent processing the mutation. This is stricter than Redis and Memcached,
which apply the returned `Expiration` as a fresh TTL. Callers must not rely on
`Database.Update` to extend retention when using this adapter.

### CDK commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
