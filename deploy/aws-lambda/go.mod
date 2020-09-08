module github.com/yopass/yopass-lambda

replace github.com/jhaals/yopass => ../../

require (
	github.com/akrylysov/algnhsa v0.12.1
	github.com/aws/aws-lambda-go v1.19.1 // indirect
	github.com/aws/aws-sdk-go v1.34.5
	github.com/jhaals/yopass v0.0.0-20200817080532-5789cbbef9b9
	github.com/prometheus/client_golang v1.7.1
	github.com/prometheus/common v0.12.0 // indirect
	golang.org/x/sys v0.0.0-20200814200057-3d37ad5750ed // indirect
	google.golang.org/protobuf v1.25.0 // indirect
)

go 1.13
