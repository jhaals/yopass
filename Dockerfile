FROM golang:alpine as app
RUN apk --no-cache add ca-certificates git
RUN mkdir -p /go/src/github.com/jhaals/yopass
WORKDIR /go/src/github.com/jhaals/yopass
COPY . .
RUN go get -u github.com/golang/dep/cmd/dep && dep ensure
WORKDIR /go/src/github.com/jhaals/yopass/server
RUN go build

FROM node as website
RUN git clone https://github.com/yopass/website
WORKDIR /website
RUN yarn install && yarn build

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=app /go/src/github.com/jhaals/yopass/server/server .
COPY --from=website /website/build /root/public
EXPOSE 1337
CMD ["./server"]