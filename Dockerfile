FROM ubuntu
MAINTAINER Johan Haals <johan.haals@gmail.com>

RUN apt-get update
RUN apt-get install -y git libsasl2-dev build-essential ruby ruby-dev memcached

RUN gem install foreman --no-rdoc --no-ri
RUN gem install bundler --no-rdoc --no-ri
RUN gem install god --no-rdoc --no-ri

RUN git clone https://github.com/jhaals/yopass /yopass
RUN cd /yopass && bundle install

EXPOSE 4567
# Ensure that both yopass and memcached is up and running
CMD ["god", "-c", "/yopass/yopass.god", "-D"]
