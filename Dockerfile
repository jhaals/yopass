FROM golang:alpine as app
RUN apk --no-cache add ca-certificates git
RUN mkdir -p /go/src/app
WORKDIR /go/src/app
COPY . /go/src/app
RUN go-wrapper download && go-wrapper install

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=app /go/src/app/public /root/public
COPY --from=app /go/bin/app .
EXPOSE 1337
CMD ["./app"]