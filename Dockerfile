FROM deliveroo/hopper-runner:1.11.4 as runner

FROM golang:buster as app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
RUN go build ./cmd/yopass && go build ./cmd/yopass-server

FROM node:18 as website
COPY website /website
WORKDIR /website
RUN yarn install --network-timeout 600000 && yarn build

FROM debian:bookworm-slim
RUN apt-get update && apt-get upgrade -y

COPY --from=app /yopass/yopass /yopass/yopass-server /
COPY --from=website /website/build /public
COPY --from=runner /hopper-runner /usr/bin/hopper-runner

COPY run_yopass.sh /run_yopass.sh
RUN chmod +x /run_yopass.sh

ARG REDIS_URL=${REDIS_URL}
ENV REDIS_URL=$REDIS_URL

EXPOSE 80

ENTRYPOINT ["hopper-runner"]
CMD ["/run_yopass.sh"]