FROM ubuntu

RUN apt-get update
RUN apt-get install -y git libsasl2-dev build-essential ruby ruby-dev memcached

RUN git clone https://github.com/jhaals/yopass /yopass
RUN gem install foreman --no-rdoc --no-ri
RUN gem install bundler --no-rdoc --no-ri
RUN cd /yopass && bundle install

EXPOSE 4567
CMD ["god", "-c", "/yopass/yopass.god", "-D"]
