#ENV['RACK_ENV'] = 'test'
require 'spec_helper'

describe 'yopass' do

  it 'should give the website' do
    get '/'
    last_response.body.should match /Share Secrets Securely/
  end

  it 'should complain about invalid lifetime' do
    post '/', params={'lifetime' => 'foo'}
    last_response.body.should match /Invalid lifetime/
  end

  it 'should complain about missing secret' do
    post '/', params={'lifetime' => '1h', 'secret' => ''}
    last_response.body.should match /No secret submitted/
  end

  it 'should complain about secret being to long' do
    post '/', params={'lifetime' => '1h', 'secret' => "0" * 10000}
    last_response.body.should match /This site is meant to store secrets not novels/
  end

  it 'should complain about not being able to connect to memcached' do
    Memcached.any_instance.stub(:set).and_raise(Memcached::ServerIsMarkedDead)
    post '/', params={'lifetime' => '1h', 'secret' => "0" * 100}
    last_response.body.should match /Can't contact memcached/
  end

  it 'should store secret' do
    Memcached.any_instance.stub(:set)
    post '/', params={'lifetime' => '1h', 'secret' => "0" * 100}
    last_response.body.should match /http:\/\/127.0.0.1:4567\/get\?k=/
  end

  it 'should receive secret' do
    Memcached.any_instance.stub(:get).and_return("\xCD\xB6\xA8\xAD\x9A\x9A\xE6\xB2\xB1\\\x8EMULf\xAC")
    Memcached.any_instance.stub(:delete)
    get '/get?p=mykey&k=123'
    last_response.body.should match /hello world/
  end

  it 'should raise Memcached::NotFound' do
    Memcached.any_instance.stub(:get).and_raise(Memcached::NotFound)
    get '/get?p=mykey&k=123'
    last_response.body.should match /Secret does not exist/
  end

  it 'should complain about invalid decryption key' do
    Memcached.any_instance.stub(:get).and_return("\xCD\xB6\xA8\xAD\x9A\x9A\xE6\xB2\xB1\\\x8EMULf\xAC")
    Memcached.any_instance.stub(:delete)
    get '/get?p=invalid&k=123'
    last_response.body.should match /Invalid decryption key/
  end

end
