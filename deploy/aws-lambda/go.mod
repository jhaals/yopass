module github.com/yopass/yopass-lambda

replace github.com/jhaals/yopass => ../../

require (
	github.com/akrylysov/algnhsa v0.12.1
	github.com/aws/aws-lambda-go v1.19.1 // indirect
	github.com/aws/aws-sdk-go v1.35.29
	github.com/jhaals/yopass v0.0.0-20201116053801-cca5a036fb85
	github.com/prometheus/client_golang v1.8.0
	google.golang.org/protobuf v1.25.0 // indirect
)

go 1.13
