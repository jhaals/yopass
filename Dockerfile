FROM ruby:2
RUN apt-get update
RUN apt-get install libsasl2-dev

# Replace with gem install yopass
ADD . /yopass
WORKDIR /yopass
RUN bundle install
EXPOSE 3000
CMD ["thin", "start"]
