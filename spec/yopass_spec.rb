require 'spec_helper'
require 'json'
describe 'yopass' do

  it 'expect complain about invalid lifetime' do
    post '/v1/secret', JSON.dump('lifetime' => 'foo')
    expect(last_response.body).to match(/Invalid lifetime/)
    expect(last_response.status).to eq 400
  end

  it 'expect complain about missing secret' do
    post '/v1/secret', JSON.dump('lifetime' => '1h', 'secret' => '')
    expect(last_response.body).to match(/No secret submitted/)
    expect(last_response.status).to eq 400

  end

  it 'expect complain about secret being to long' do
    post '/v1/secret', JSON.dump('lifetime' => '1h', 'secret' => '0' * 10000)
    expect(last_response.body).to match(/This site is meant to store secrets not novels/)
    expect(last_response.status).to eq 400
  end

  it 'expect complain about not being able to connect to memcached' do
    allow_any_instance_of(Memcached).to receive(:set).and_raise(Memcached::ServerIsMarkedDead)
    post '/v1/secret', JSON.dump('lifetime' => '1h', 'secret' => '0' * 100)
    expect(last_response.body).to match(/Unable to contact memcached/)
    expect(last_response.status).to eq 500
  end

  it 'expect store secret' do
    allow_any_instance_of(Memcached).to receive(:set).and_return true
    post '/v1/secret', JSON.dump('lifetime' => '1h', 'secret' => 'test')

    expect(last_response.body).to match(/http:\/\/127.0.0.1:4567/)
    expect(last_response.body).to match(/full_url/)
    expect(last_response.body).to match(/decryption_key/)
    expect(last_response.body).to match(/key/)
    expect(last_response.body).to match(/short_url/)
    expect(last_response.status).to eq 200
  end

  it 'expect receive secret' do
    allow_any_instance_of(Memcached).to receive(:get).and_return("\xD5\x9E\xF7\xB1\xA0\xEC\xD6\xBD\xCA\x00nW\xAD\xB3\xF4\xDA")
    allow_any_instance_of(Memcached).to receive(:delete).and_return true
    get '/v1/secret/8937c6de9fb7b0ba9b7652b769743b4e/3af71378a'
    expect(last_response.body).to match(/hello world/)
    expect(last_response.status).to eq 200
  end

  it 'expect raise Memcached::NotFound' do
    allow_any_instance_of(Memcached).to receive(:get).and_raise(Memcached::NotFound)
    get '/v1/secret/mykey/123'
    expect(last_response.body).to match(/Not found/)
    expect(last_response.status).to eq 404
  end
end
