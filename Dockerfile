
FROM golang:buster as app
RUN mkdir -p /entrata_yopass
WORKDIR /entrata_yopass
COPY . .
RUN go build ./cmd/yopass && go build ./cmd/yopass-server

FROM node:18 as website
COPY website /website
WORKDIR /website
RUN yarn install --network-timeout 600000 && yarn build

FROM gcr.io/distroless/base
COPY --from=app /entrata_yopass/yopass /entrata_yopass/yopass-server /
COPY --from=website /website/build /public
ENTRYPOINT ["/yopass-server"]
