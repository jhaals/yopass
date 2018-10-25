FROM golang:stretch as app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
WORKDIR /yopass/cmd/yopass
RUN go get && go build

FROM node as website
COPY website /website
WORKDIR /website
RUN yarn install && yarn build

FROM gcr.io/distroless/base
COPY --from=app /yopass/cmd/yopass/yopass /
COPY --from=website /website/build /public
ENTRYPOINT ["/yopass"]
